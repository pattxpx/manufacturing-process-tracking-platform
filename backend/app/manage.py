"""Operator commands. Run from the backend folder:

    python -m app.manage create-admin --username alice --full-name "Alice Example"
    python -m app.manage reset-password --username alice

The password is read from the INITIAL_ADMIN_PASSWORD environment variable if it is set (handy for a one-off
deploy command, and remove it afterwards), otherwise it is typed in at a hidden prompt. It is never printed,
logged or accepted as a command-line argument (arguments show up in process lists and shell history).
"""
import argparse
import getpass
import os
import sys

from sqlalchemy import select

from app.auth import permissions
from app.auth.passwords import hash_password, password_problem
from app.auth.sessions import revoke_user_sessions
from app.database import SessionLocal
from app.models import User, utcnow
from app.services import audit

OPERATOR = "cli"


def read_password(username: str) -> str:
    password = os.environ.get("INITIAL_ADMIN_PASSWORD")
    if password is None:
        if not sys.stdin.isatty():
            sys.exit("No INITIAL_ADMIN_PASSWORD set and no terminal to ask on.")
        password = getpass.getpass("Password: ")
        if getpass.getpass("Repeat password: ") != password:
            sys.exit("The passwords do not match.")
    problem = password_problem(password, username)
    if problem:
        sys.exit(problem)
    return password


def create_admin(username: str, full_name: str) -> None:
    username = username.strip().lower()
    password = read_password(username)
    with SessionLocal() as db:
        if db.execute(select(User).where(User.username == username)).scalar_one_or_none():
            sys.exit(f"A user named '{username}' already exists.")
        user = User(username=username, full_name=full_name, password_hash=hash_password(password),
                    role=permissions.DEFAULT_ROLE)
        db.add(user)
        db.flush()
        audit.record_now("user_created", actor_username=OPERATOR, target_type="user", target_id=user.id,
                         details={"username": username, "role": user.role, "via": "manage.py"})
        db.commit()
    print(f"Created {permissions.DEFAULT_ROLE} '{username}'.")


def reset_password(username: str) -> None:
    username = username.strip().lower()
    password = read_password(username)
    with SessionLocal() as db:
        user = db.execute(select(User).where(User.username == username)).scalar_one_or_none()
        if user is None:
            sys.exit(f"No user named '{username}'.")
        user.password_hash = hash_password(password)
        user.password_changed_at = utcnow()
        revoke_user_sessions(db, user.id)
        audit.record_now("password_reset", actor_username=OPERATOR, target_type="user", target_id=user.id,
                         details={"via": "manage.py"})
        db.commit()
    print(f"Password changed for '{username}'. All their sessions were ended.")


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app.manage")
    commands = parser.add_subparsers(dest="command", required=True)
    admin = commands.add_parser("create-admin", help="Create an administrator account")
    admin.add_argument("--username", required=True)
    admin.add_argument("--full-name", required=True)
    reset = commands.add_parser("reset-password", help="Set a new password for an existing user")
    reset.add_argument("--username", required=True)
    args = parser.parse_args()
    if args.command == "create-admin":
        create_admin(args.username, args.full_name)
    else:
        reset_password(args.username)


if __name__ == "__main__":
    main()
