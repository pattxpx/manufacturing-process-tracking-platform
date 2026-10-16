from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import permissions
from app.auth.dependencies import Actor, client_ip, require
from app.auth.passwords import hash_password, password_problem
from app.auth.ratelimit import SENSITIVE_PER_USER, limiter
from app.auth.sessions import revoke_user_sessions
from app.database import get_db
from app.errors import BusinessRuleError, not_found
from app.models import User, utcnow
from app.schemas import PasswordReset, UserCreate, UserOut, UserUpdate
from app.services import audit

router = APIRouter(prefix="/api/users", tags=["users"])
manage = require(permissions.USERS_MANAGE)


def throttle(actor: Actor) -> None:
    wait = limiter.hit(f"sensitive:{actor.user_id}", *SENSITIVE_PER_USER)
    if wait:
        raise HTTPException(429, "Too many requests. Slow down.", headers={"Retry-After": str(wait)})


def other_managers(db: Session, user: User) -> int:
    """How many OTHER active users could still manage users? Used so the last one cannot be removed."""
    users = db.execute(select(User).where(User.is_active, User.id != user.id)).scalars()
    return sum(1 for u in users if permissions.has_permission(u.role, permissions.USERS_MANAGE))


def check_role(role: str) -> None:
    if not permissions.is_valid_role(role):
        raise BusinessRuleError(f"Unknown role '{role}'. Defined roles: {', '.join(sorted(permissions.ROLE_PERMISSIONS))}", 422)


@router.get("/roles")
def list_roles(actor: Actor = Depends(manage)):
    """The roles that can be given to a user, with their permissions (from app/auth/permissions.py)."""
    return [{"name": name, "permissions": sorted(perms)} for name, perms in sorted(permissions.ROLE_PERMISSIONS.items())]


@router.get("", response_model=list[UserOut])
def list_users(actor: Actor = Depends(manage), db: Session = Depends(get_db)):
    return db.execute(select(User).order_by(User.username)).scalars().all()


@router.post("", response_model=UserOut, status_code=201)
def create_user(body: UserCreate, request: Request, actor: Actor = Depends(manage), db: Session = Depends(get_db)):
    throttle(actor)
    username = body.username.lower()
    check_role(body.role)
    problem = password_problem(body.password, username)
    if problem:
        raise BusinessRuleError(problem, 422)
    user = User(username=username, full_name=body.full_name, password_hash=hash_password(body.password), role=body.role)
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise BusinessRuleError(f"The user name '{username}' is already taken")
    audit.record(db, "user_created", actor, target_type="user", target_id=user.id, ip=client_ip(request),
                 details={"username": username, "role": user.role})
    db.commit()
    return user


@router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: int, body: UserUpdate, request: Request, actor: Actor = Depends(manage),
                db: Session = Depends(get_db)):
    throttle(actor)
    user = db.execute(select(User).where(User.id == user_id).with_for_update()).scalar_one_or_none()
    if user is None:
        raise not_found("User")
    changes = body.model_dump(exclude_unset=True)
    ip = client_ip(request)

    if "role" in changes and changes["role"] != user.role:
        check_role(changes["role"])
        if not permissions.has_permission(changes["role"], permissions.USERS_MANAGE) and other_managers(db, user) == 0:
            raise BusinessRuleError("At least one active user must keep the right to manage users")
        audit.record(db, "user_role_changed", actor, target_type="user", target_id=user.id, ip=ip,
                     details={"from": user.role, "to": changes["role"]})
        user.role = changes["role"]
        revoke_user_sessions(db, user.id)  # the new role applies from the next sign-in
    if "is_active" in changes and changes["is_active"] != user.is_active:
        if not changes["is_active"]:
            if user.id == actor.user_id:
                raise BusinessRuleError("You cannot deactivate your own account")
            if other_managers(db, user) == 0:
                raise BusinessRuleError("At least one active user must keep the right to manage users")
            revoke_user_sessions(db, user.id)
        audit.record(db, "user_activated" if changes["is_active"] else "user_deactivated", actor,
                     target_type="user", target_id=user.id, ip=ip)
        user.is_active = changes["is_active"]
    if "full_name" in changes and changes["full_name"].strip() != user.full_name:
        user.full_name = changes["full_name"].strip()
    user.updated_at = utcnow()
    db.commit()
    return user


@router.post("/{user_id}/reset-password", status_code=204)
def reset_password(user_id: int, body: PasswordReset, request: Request, actor: Actor = Depends(manage),
                   db: Session = Depends(get_db)):
    throttle(actor)
    user = db.get(User, user_id)
    if user is None:
        raise not_found("User")
    problem = password_problem(body.new_password, user.username)
    if problem:
        raise BusinessRuleError(problem, 422)
    user.password_hash = hash_password(body.new_password)
    user.password_changed_at = utcnow()
    revoke_user_sessions(db, user.id)
    audit.record(db, "password_reset", actor, target_type="user", target_id=user.id, ip=client_ip(request))
    db.commit()
