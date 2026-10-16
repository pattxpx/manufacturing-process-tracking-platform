import math

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

MAX_PAGE_SIZE = 100


def paginate(db: Session, query: Select, page: int, page_size: int) -> dict:
    """Run one page of an already filtered and ordered query.

    The count and the page are both done by the database, so nothing is loaded just to be sliced away.
    If the page is past the end (for example because rows were removed meanwhile), the last page is
    returned, and the response says which page that was.
    The query must have a unique tie-breaker (such as the id) in its ORDER BY, so pages never overlap.
    """
    total = db.execute(select(func.count()).select_from(query.order_by(None).subquery())).scalar_one()
    total_pages = max(1, math.ceil(total / page_size))
    page = min(page, total_pages)
    items = db.execute(query.limit(page_size).offset((page - 1) * page_size)).scalars().all()
    return {"items": items, "total": total, "page": page, "page_size": page_size, "total_pages": total_pages}
