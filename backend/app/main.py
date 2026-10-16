import logging

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import DataError
from sqlalchemy.orm import Session
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app import config
from app.auth.clientip import resolve_client_ip
from app.auth.ratelimit import API_REQUESTS_PER_IP, limiter
from app.database import get_db
from app.errors import BusinessRuleError
from app.routes import audit_log, auth, operations, orders, schedule, users, ws

logger = logging.getLogger("app")

if config.IS_PRODUCTION:
    problems = config.production_problems()
    if problems:
        raise RuntimeError("Unsafe production configuration: " + "; ".join(problems))

docs = config.ENABLE_API_DOCS
app = FastAPI(
    title="Manufacturing Process Tracking (demo)",
    docs_url="/docs" if docs else None, redoc_url=None, openapi_url="/openapi.json" if docs else None,
)


# ---------- Request limits and security headers (plain ASGI middleware) ----------

class RequestTooLarge(Exception):
    pass


class SecurityMiddleware:
    """Body size limit, a per-address request limit for /api, and security headers on every response."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        headers = dict(scope["headers"])
        path = scope["path"]
        client = scope.get("client")
        forwarded = ", ".join(v.decode("latin1") for k, v in scope["headers"] if k == b"x-forwarded-for")
        ip = resolve_client_ip(client[0] if client else None, forwarded, config.TRUSTED_PROXY_HOPS)

        if path.startswith("/api"):
            wait = limiter.hit(f"api:{ip}", *API_REQUESTS_PER_IP)
            if wait:
                return await self.reject(scope, receive, send, 429, "Too many requests", {"retry-after": str(wait)})
        length = headers.get(b"content-length")
        if length and length.isdigit() and int(length) > config.MAX_BODY_BYTES:
            return await self.reject(scope, receive, send, 413, "Request body too large")

        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > config.MAX_BODY_BYTES:
                    raise RequestTooLarge()
            return message

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                message["headers"] = [h for h in message["headers"] if h[0].lower() != b"server"] + self.security_headers(path)
            await send(message)

        try:
            await self.app(scope, limited_receive, send_with_headers)
        except RequestTooLarge:
            await self.reject(scope, receive, send, 413, "Request body too large")

    def security_headers(self, path: str) -> list[tuple[bytes, bytes]]:
        pairs = {
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
            "referrer-policy": "no-referrer",
            "cache-control": "no-store",  # API answers can contain business data
            "permissions-policy": "camera=(), microphone=(), geolocation=()",
        }
        if path not in ("/docs", "/openapi.json"):
            pairs["content-security-policy"] = "default-src 'none'; frame-ancestors 'none'"
        if config.IS_PRODUCTION:
            pairs["strict-transport-security"] = "max-age=31536000; includeSubDomains"
        return [(k.encode(), v.encode()) for k, v in pairs.items()]

    async def reject(self, scope, receive, send, status, message, extra=None):
        response = JSONResponse({"detail": message}, status_code=status, headers=extra)
        await response(scope, receive, send_with_security(send, self.security_headers(scope["path"])))


def send_with_security(send, headers):
    async def wrapped(message):
        if message["type"] == "http.response.start":
            message["headers"] = list(message.get("headers", [])) + headers
        await send(message)
    return wrapped


app.add_middleware(SecurityMiddleware)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=config.ALLOWED_HOSTS)


# ---------- Errors: never leak internals or echo back what the client sent ----------

@app.exception_handler(BusinessRuleError)
def business_rule_error(request: Request, error: BusinessRuleError):
    return JSONResponse(status_code=error.status_code, content={"detail": error.message})


@app.exception_handler(RequestValidationError)
def validation_error(request: Request, error: RequestValidationError):
    # FastAPI's default answer includes the submitted values ("input"), which could be a password. Only say what is wrong.
    detail = [{"loc": e["loc"], "msg": e["msg"], "type": e["type"]} for e in error.errors()]
    return JSONResponse(status_code=422, content={"detail": detail})


@app.exception_handler(DataError)
def data_error(request: Request, error: DataError):
    # The database refused the value (for example a NUL byte). That is the client's mistake, not a server fault.
    return JSONResponse(status_code=422, content={"detail": "The request contains a value that cannot be stored"})


@app.exception_handler(Exception)
def unexpected_error(request: Request, error: Exception):
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)  # the log keeps the details
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.get("/api/health")
def health(db: Session = Depends(get_db)):
    """For the platform's health check. Public, and says nothing except whether the database answers."""
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        logger.exception("Health check: the database did not answer")
        return JSONResponse(status_code=503, content={"status": "unavailable"})
    return {"status": "ok"}


app.include_router(auth.router)
app.include_router(users.router)
app.include_router(audit_log.router)
app.include_router(orders.router)
app.include_router(schedule.router)
app.include_router(operations.router)
app.include_router(ws.router)
