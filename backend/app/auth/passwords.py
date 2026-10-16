"""Password hashing with Argon2id (the `argon2-cffi` library, default parameters). Nothing is implemented by hand."""
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_hasher = PasswordHasher()  # Argon2id

# Checked when the user does not exist, so a wrong user name takes as long as a wrong password.
_DUMMY_HASH = _hasher.hash("this-is-not-a-real-password")

MIN_LENGTH = 12
MAX_LENGTH = 128


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def password_problem(password: str, username: str = "") -> str | None:
    """Why this password is not acceptable (None if it is fine). Length matters most (NIST SP 800-63B)."""
    if len(password) < MIN_LENGTH:
        return f"The password must be at least {MIN_LENGTH} characters long."
    if len(password) > MAX_LENGTH:
        return f"The password must be at most {MAX_LENGTH} characters long."
    if username and username.lower() in password.lower():
        return "The password must not contain the user name."
    if len(set(password)) < 5:
        return "The password is too repetitive."
    return None
