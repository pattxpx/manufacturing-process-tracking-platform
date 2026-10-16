"""Which address is the client? Behind a reverse proxy the connecting address is the proxy's, so the real one has to
come from X-Forwarded-For, but that header is also something a client can send itself.

Each proxy ADDS the address it saw to the RIGHT end of the list, so only entries counted from the right are
trustworthy. TRUSTED_PROXY_HOPS says how many proxies are ours; everything to the left of those is client-supplied
and ignored. (uvicorn's own FORWARDED_ALLOW_IPS=* would take the leftmost entry, which a client can choose.)"""
import ipaddress


def resolve_client_ip(peer: str | None, forwarded_for: str | None, hops: int) -> str:
    peer = peer or "unknown"
    if hops <= 0 or not forwarded_for:
        return peer
    entries = [entry.strip() for entry in forwarded_for.split(",")]
    if len(entries) < hops:
        return peer  # the header is shorter than our proxies should have made it: do not guess
    candidate = entries[-hops]
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return peer
