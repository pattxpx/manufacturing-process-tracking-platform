import os
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

# Reads backend/.env if it exists. Real environment variables win.
load_dotenv()


def _flag(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    return default if value is None else value.strip().lower() in ("1", "true", "yes", "on")


def _list(name: str, default: str) -> list[str]:
    return [item.strip() for item in os.environ.get(name, default).split(",") if item.strip()]


ENVIRONMENT = os.environ.get("ENVIRONMENT", "development")  # development | test | production
IS_PRODUCTION = ENVIRONMENT == "production"

def normalize_database_url(url: str) -> str:
    """Hosting platforms give out postgres:// or postgresql:// URLs. This app uses the psycopg 3 driver."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


DATABASE_URL = normalize_database_url(os.environ.get("DATABASE_URL", "postgresql+psycopg://localhost:5432/mfg"))

# The website's address(es). Used to check the Origin of state-changing requests and WebSocket connections.
ALLOWED_ORIGINS = _list("ALLOWED_ORIGINS", "http://localhost:3000")
# Host names this server answers to (protects against Host header attacks).
ALLOWED_HOSTS = _list("ALLOWED_HOSTS", "localhost,127.0.0.1,testserver")

# How many reverse proxies sit between the internet and this server AND add their view of the client to
# X-Forwarded-For. 0 (default): the header is ignored and the connecting address is used. With N, the address that
# the N-th proxy from the server's side recorded is used. Entries further left are supplied by the client and are never trusted.
TRUSTED_PROXY_HOPS = int(os.environ.get("TRUSTED_PROXY_HOPS", "0"))

# Sessions: a login ends after this much inactivity, or after this long in total.
SESSION_IDLE_MINUTES = int(os.environ.get("SESSION_IDLE_MINUTES", "120"))
SESSION_MAX_HOURS = int(os.environ.get("SESSION_MAX_HOURS", "12"))
# The Secure flag keeps the cookie off plain HTTP. It must be on in production.
COOKIE_SECURE = _flag("COOKIE_SECURE", IS_PRODUCTION)

# Planned times are stored in UTC and shown in this time zone (an IANA name such as "Asia/Bangkok").
APP_TIMEZONE = os.environ.get("APP_TIMEZONE", "UTC")

# The automatic API documentation lists every endpoint, so it is off in production by default.
ENABLE_API_DOCS = _flag("ENABLE_API_DOCS", not IS_PRODUCTION)

# Requests per minute allowed from one address (counted for /api). Counts everyone behind a shared address
# (an office), so the default is generous. It only exists to stop floods.
API_RATE_LIMIT_PER_MINUTE = int(os.environ.get("API_RATE_LIMIT_PER_MINUTE", "1800"))

MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(1_000_000)))


def timezone() -> ZoneInfo:
    return ZoneInfo(APP_TIMEZONE)


def production_problems() -> list[str]:
    """Settings that are unsafe in production. The server refuses to start while this list is not empty."""
    problems = []
    if not COOKIE_SECURE:
        problems.append("COOKIE_SECURE must be true")
    if not ALLOWED_ORIGINS or any(not origin.startswith("https://") for origin in ALLOWED_ORIGINS):
        problems.append("ALLOWED_ORIGINS must list the website's https:// address(es)")
    if "ALLOWED_HOSTS" not in os.environ or "*" in ALLOWED_HOSTS:
        problems.append("ALLOWED_HOSTS must be set to the real host name(s), not '*'")
    if "DATABASE_URL" not in os.environ:
        problems.append("DATABASE_URL must be set")
    if not 0 <= TRUSTED_PROXY_HOPS <= 5:
        problems.append("TRUSTED_PROXY_HOPS must be between 0 and 5")
    try:
        timezone()
    except Exception:
        problems.append("APP_TIMEZONE is not a valid time zone name")
    return problems
