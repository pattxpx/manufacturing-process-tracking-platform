"""What every protected endpoint depends on: a valid login, CSRF protection, and a permission check."""
import hmac
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app import config
from app.auth import permissions
from app.auth.clientip import resolve_client_ip
from app.auth.sessions import find_session
from app.database import get_db
from app.services import audit

SESSION_COOKIE = "__Host-session" if config.COOKIE_SECURE else "session"  # __Host- = this host only, Secure, Path=/
CSRF_HEADER = "x-csrf-token"
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


@dataclass
class Actor:
    """Who is making the request. Built only from the verified session, never from the request body."""

    user_id: int
    username: str
    full_name: str
    role: str
    session_id: int
    csrf_token: str

    def can(self, permission: str) -> bool:
        return permissions.has_permission(self.role, permission)


def client_ip(request: Request) -> str:
    return resolve_client_ip(
        request.client.host if request.client else None,
        ", ".join(request.headers.getlist("x-forwarded-for")), config.TRUSTED_PROXY_HOPS,
    )


def check_origin(request: Request) -> None:
    """A browser always says where a request comes from. Refuse requests that come from another website."""
    origin = request.headers.get("origin")
    if origin is not None:
        if origin not in config.ALLOWED_ORIGINS:
            raise HTTPException(403, "Request origin not allowed")
    elif request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "Request origin not allowed")


def get_actor(request: Request, db: Session = Depends(get_db)) -> Actor:
    """The signed-in user. 401 if there is no valid session. For state-changing requests the CSRF token
    and the Origin must also be right."""
    found = find_session(db, request.cookies.get(SESSION_COOKIE))
    if found is None:
        raise HTTPException(401, "Not authenticated")
    session, user = found

    if request.method in UNSAFE_METHODS:
        check_origin(request)
        sent = request.headers.get(CSRF_HEADER, "")
        if not hmac.compare_digest(sent.encode(), session.csrf_token.encode()):
            raise HTTPException(403, "Missing or invalid CSRF token")

    return Actor(user.id, user.username, user.full_name, user.role, session.id, session.csrf_token)


def require(permission: str):
    """Dependency factory: the endpoint needs this permission. Returns the Actor."""

    def dependency(request: Request, actor: Actor = Depends(get_actor)) -> Actor:
        if not actor.can(permission):
            audit.record_now(
                "permission_denied", actor, success=False, ip=client_ip(request),
                details={"permission": permission, "method": request.method, "path": request.url.path},
            )
            raise HTTPException(403, "You do not have permission to do this")
        return actor

    return dependency
