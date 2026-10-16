"""A small in-memory sliding-window rate limiter (no extra infrastructure), used for flood protection:
requests per address, and sensitive actions per user.

Limits are per server process. With several server replicas each one counts for itself, so the real limit
is a little higher. Failed sign-ins and failed password changes are NOT limited here: they are counted in the
database (see throttle.py), so those limits are shared by every replica.
"""
import threading
import time
from collections import defaultdict, deque

from app import config


class RateLimiter:
    def __init__(self, clock=time.monotonic):
        self._events: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()
        self._clock = clock

    def _prune(self, key: str, window: float) -> deque:
        events = self._events[key]
        cutoff = self._clock() - window
        while events and events[0] <= cutoff:
            events.popleft()
        if not events:
            self._events.pop(key, None)
        return events

    def retry_after(self, key: str, limit: int, window: float) -> int:
        """0 if another event is allowed, otherwise the number of seconds until one is. Records nothing."""
        with self._lock:
            events = self._prune(key, window)
            if len(events) < limit:
                return 0
            return max(1, int(events[0] + window - self._clock()) + 1)

    def record(self, key: str) -> None:
        with self._lock:
            self._events[key].append(self._clock())

    def hit(self, key: str, limit: int, window: float) -> int:
        """Record an event if allowed. Returns 0 if it was allowed, else the seconds to wait."""
        wait = self.retry_after(key, limit, window)
        if wait == 0:
            self.record(key)
        return wait

    def clear(self, key: str) -> None:
        with self._lock:
            self._events.pop(key, None)

    def reset(self) -> None:
        with self._lock:
            self._events.clear()


limiter = RateLimiter()

# Everything under /api, per address (the number comes from configuration)
API_REQUESTS_PER_IP = (config.API_RATE_LIMIT_PER_MINUTE, 60)
# Sensitive actions by a signed-in user
SENSITIVE_PER_USER = (30, 60)
