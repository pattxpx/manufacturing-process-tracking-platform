import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import config
from app.auth import permissions
from app.auth.dependencies import SESSION_COOKIE, Actor, check_origin, client_ip, get_actor, require
from app.auth.passwords import hash_password, needs_rehash, password_problem, verify_password
from app.auth.throttle import login_blocked_for, password_change_blocked_for, serialise
from app.auth.sessions import (
    create_session, create_ws_ticket, find_session, purge_expired, revoke_session, revoke_user_sessions,
)
from app.database import get_db
from app.events import disconnect_session
from app.models import User, UserSession, utcnow
from app.schemas import ChangePasswordRequest, LoginRequest, MeOut
from app.services import audit

router = APIRouter(prefix="/api/auth", tags=["auth"])
logger = logging.getLogger("auth")

GENERIC_LOGIN_ERROR = "Invalid username or password."  # the same text whatever was wrong


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE, token, httponly=True, secure=config.COOKIE_SECURE, samesite="lax", path="/",
    )  # no Max-Age: a browser-session cookie. The server enforces the real expiry.


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, httponly=True, secure=config.COOKIE_SECURE, samesite="lax", path="/")


def me_payload(user: User, csrf_token: str) -> dict:
    return {
        "user": user,
        "permissions": sorted(permissions.permissions_for(user.role)),
        "csrf_token": csrf_token,
        "timezone": config.APP_TIMEZONE,
    }


def too_many(wait: int, message: str) -> HTTPException:
    return HTTPException(429, message, headers={"Retry-After": str(wait)})


@router.post("/login", response_model=MeOut)
def login(body: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)):
    check_origin(request)
    ip = client_ip(request)
    username = body.username.strip().lower()
    # The counts come from the audit trail in the database, so they are the same on every server instance
    serialise(db, "login", username)  # one attempt per user at a time, so a burst cannot all pass the check
    wait = login_blocked_for(db, username, ip)
    if wait:
        audit.record_now("login_blocked", actor_username=username[:50], success=False, ip=ip)
        raise too_many(wait, "Too many failed sign-in attempts. Try again later.")

    user = db.execute(select(User).where(User.username == username)).scalar_one_or_none()
    # The hash is always checked (a dummy one for unknown users), so timing does not reveal which part was wrong
    password_ok = verify_password(user.password_hash if user else None, body.password)
    if user is None or not password_ok or not user.is_active:
        audit.record_now("login_failed", actor_username=username[:50], success=False, ip=ip)
        raise HTTPException(401, GENERIC_LOGIN_ERROR)

    # A new session with a new token at every login. A token that was presented before is retired.
    previous = request.cookies.get(SESSION_COOKIE)
    if previous:
        found = find_session(db, previous)
        if found:
            revoke_session(db, found[0].id)
    token, session = create_session(db, user, ip, request.headers.get("user-agent"))
    user.last_login_at = utcnow()
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)
    purge_expired(db)
    audit.record(db, "login_success", Actor(user.id, user.username, user.full_name, user.role, session.id, ""),
                 target_type="user", target_id=user.id, ip=ip)
    db.commit()
    set_session_cookie(response, token)
    return me_payload(user, session.csrf_token)


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, actor: Actor = Depends(get_actor), db: Session = Depends(get_db)):
    revoke_session(db, actor.session_id)  # the server forgets the login, not just the browser
    audit.record(db, "logout", actor, target_type="user", target_id=actor.user_id, ip=client_ip(request))
    db.commit()
    disconnect_session(actor.session_id)
    clear_session_cookie(response)


@router.get("/me", response_model=MeOut)
def me(actor: Actor = Depends(get_actor), db: Session = Depends(get_db)):
    user = db.get(User, actor.user_id)
    return me_payload(user, actor.csrf_token)


@router.post("/change-password", status_code=204)
def change_password(body: ChangePasswordRequest, request: Request, actor: Actor = Depends(get_actor),
                    db: Session = Depends(get_db)):
    ip = client_ip(request)
    serialise(db, "password-change", str(actor.user_id))
    wait = password_change_blocked_for(db, actor.user_id)
    if wait:
        raise too_many(wait, "Too many attempts. Try again later.")
    user = db.get(User, actor.user_id)
    if not verify_password(user.password_hash, body.current_password):
        audit.record_now("password_change_failed", actor, success=False, ip=ip)
        raise HTTPException(400, "The current password is not correct.")
    problem = password_problem(body.new_password, user.username)
    if problem:
        raise HTTPException(422, problem)
    user.password_hash = hash_password(body.new_password)
    user.password_changed_at = utcnow()
    revoke_user_sessions(db, user.id, except_session_id=actor.session_id)  # other devices must sign in again
    audit.record(db, "password_changed", actor, target_type="user", target_id=user.id, ip=ip)
    db.commit()


@router.post("/ws-ticket")
def websocket_ticket(actor: Actor = Depends(require(permissions.PRODUCTION_READ)), db: Session = Depends(get_db)):
    """A single-use, 30-second pass for the live-updates WebSocket."""
    session = db.get(UserSession, actor.session_id)
    ticket = create_ws_ticket(db, session)
    db.commit()
    return {"ticket": ticket}
