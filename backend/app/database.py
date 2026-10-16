from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import DATABASE_URL

# Every connection speaks UTC, so timestamps always leave the API in UTC whatever the database server's own setting is.
# hide_parameters: database error messages (which end up in logs) never contain the values being stored
engine = create_engine(DATABASE_URL, pool_pre_ping=True, hide_parameters=True, connect_args={"options": "-c timezone=UTC"})
SessionLocal = sessionmaker(bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency: one database session per request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
