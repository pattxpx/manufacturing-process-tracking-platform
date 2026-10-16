# Security audit and hardening report

Scope: the whole application: Next.js frontend, FastAPI backend, WebSocket, PostgreSQL schema and migrations, dependencies and configuration.
Method: code review, then tests that attack each control (unauthenticated access, direct API calls, forged and cross-site requests, privilege escalation, mass assignment, replayed tickets and cookies,
brute force, oversized and malformed input), a scan of the whole API for unprotected endpoints, an automated accessibility audit, and dependency audits.

> **This is not a claim of OWASP compliance, of a secure system, or of an independent penetration test.** It records what was reviewed, what was fixed and how each fix is verified,
> what remains open, and what was **not** verified (sections 5–7). Setup and operation are described in [README.md](README.md).

## 1. Confirmed findings in the original application

| ID | Severity | Finding | OWASP 2021 | Now |
|---|---|---|---|---|
| C1 | Critical | No authentication or authorization: every endpoint, including creating orders, production steps, QC decisions and release, was open to anyone who could reach the server | A01, A07 | Fixed: session sign-in, a named permission on every endpoint |
| C2 | Critical | Nothing recorded who did what; QC and release were anonymous | A09 | Fixed: actor on history and inspections, audit trail |
| H1 | High | WebSocket open to anyone, no Origin check (cross-site WebSocket hijacking), no limits | A01, A05 | Fixed: ticket + Origin check + re-validation + limits |
| H2 | High | CORS allowed all methods and headers | A05 | Fixed: no CORS is configured (same-origin proxy) |
| H3 | High | No rate limiting | A04, A07 | Fixed: sign-in and password-change limits shared by all instances (database); flood limits per process (6) |
| H4 | High | Mass assignment possible: unknown request fields were silently ignored | A01, A04 | Fixed: unknown fields are refused (HTTP 422) |
| H5 | High | `/docs` and `/openapi.json` public; default error bodies | A05 | Fixed: off in production; generic 500 answers |
| H6 | High | No security headers, CSP, HSTS, trusted hosts or request size limit | A05 | Fixed (section 3) |
| M1 | Medium | No audit trail, and the order history and inspection records could be edited or deleted | A09 | Fixed: audit trail; history tables append-only at database level |
| M2 | Medium | No controlled way to adjust stock | A04 | Fixed: stock-adjustment ledger |

Checked and found sound in the original code: SQL injection (the ORM uses bound parameters; the only raw SQL is constant text in the seed script and migrations), XSS (React escaping, no `dangerouslySetInnerHTML`,
nothing in `localStorage`/`sessionStorage`), and server-side enforcement of the business rules (steps, FIFO, atomic reservations, duplicate completion, QC/release, edit locks), which have concurrency tests.

## 2. Further problems found while building and testing

Found by the new tests, not by reading the code:

- A NUL byte in a search parameter or text field caused an unhandled **500** (database error). Filters now accept only valid values and lengths, and any database data error becomes a clean 422.
- FastAPI's default 422 answer **echoes the submitted values**, which for a login form can be the password. Replaced by an answer that says only what is wrong.
- Timestamps left the API in the **database server's time zone** (for example `+07:00`). Every connection is now pinned to UTC.
- Database error messages (which reach logs) contained bound parameter values. Disabled (`hide_parameters`).
- A route scan test silently found only 1 of 36 routes (FastAPI stores included routers differently). Replaced by the OpenAPI description, plus a test that fails if the scan finds too few.
- Accessibility defects found by tests: focus fell to the page body when a dialog closed; two buttons whose accessible name did not contain their visible text; an invalid `<dl>` structure.

## 3. Mitigations implemented

**Authentication and sessions** (`backend/app/auth/`, `routes/auth.py`)
- Argon2id password hashing (`argon2-cffi`; no custom cryptography). 12–128 characters, not containing the user name, not trivially repetitive. A dummy hash is checked for unknown users, so timing does not reveal them.
- Server-side sessions: a 256-bit random token from the operating system, only its SHA-256 hash stored; idle timeout (default 120 min) and absolute lifetime (default 12 h); a new session at every login (a session presented at login is retired);
  revoked on logout, password change (other sessions), password reset, role change and deactivation.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, no `Max-Age`; `Secure` and the `__Host-` name prefix when `COOKIE_SECURE` is on (the default in production).
- CSRF: a per-session token in the `X-CSRF-Token` header (kept in page memory) **and** an `Origin` / `Sec-Fetch-Site` check on every state-changing request, including login.
- Login errors are identical for wrong password, unknown user and disabled user. Failures are counted per user+address (5), per address (20) and per user (30) within 15 minutes and answered with 429 and `Retry-After`; failed and blocked attempts are audited.
  **The counts are read from the audit trail in PostgreSQL** (`app/auth/throttle.py`), so every server instance sees the same numbers and a restart does not reset them. Failed password changes (5 per 15 minutes) are throttled the same way.
  Attempts for one user (or one password change) are serialised with a PostgreSQL advisory lock, so a simultaneous burst cannot pass the check together (regression test: 12 parallel wrong passwords give exactly 5 × 401 and 7 × 429; the test fails without the lock). The per-address limit has no lock and can overshoot by the requests in flight. If the database fails, sign-in returns 500 and sets no cookie (it fails closed); counts are kept in the database and apply again when it returns.
- Client address (`app/auth/clientip.py`): `X-Forwarded-For` is ignored unless `TRUSTED_PROXY_HOPS` is set, and then only the entry the N-th trusted proxy added (counted from the right) is used, so a client cannot choose its own address by sending the header.
  Documented as unsafe and no longer recommended: uvicorn's `FORWARDED_ALLOW_IPS=*`, which believes the left-most (client-written) entry.
- First administrator: `python -m app.manage create-admin` (password from a hidden prompt, or `INITIAL_ADMIN_PASSWORD` for non-interactive use; never an argument, never printed or written to the audit trail). No default account exists.

**Authorization**
- One named permission per endpoint (`app/auth/permissions.py`), checked on the server. Today the only role is `admin`, which has every permission, and every account is an admin. Code never asks "is admin".
  Unknown roles have no permissions. No public registration; only `users:manage` can create users or change roles. The last user able to manage users cannot be deactivated or demoted.
- Request bodies forbid unknown fields; the actor in history, inspections, stock adjustments and the audit trail comes only from the session.

**WebSocket** (`routes/ws.py`): `Origin` must be allowed; a single-use 30-second ticket bound to the session, sent as a subprotocol (so it is not in URLs or access logs); the user needs `production:read`;
at most 10 sockets per user; the session is re-checked every 30 seconds, and logout closes the sockets; client messages are limited to 1 KB and 30 per minute; events carry ids only.

**Transport, headers, limits**
- Frontend (`next.config.ts`, `proxy.ts`): Content-Security-Policy with a per-request nonce and `strict-dynamic` (no `unsafe-eval`, no `unsafe-inline` for scripts; `unsafe-eval` only in development), `frame-ancestors 'none'`, `object-src 'none'`,
  `form-action 'self'`, `connect-src` limited to the site and the WebSocket address, HSTS in production, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, no `X-Powered-By`.
- Backend (`app/main.py`): the same family of headers, `Cache-Control: no-store`, trusted-host check, 1 MB body limit, per-address request limit (default 1800/min), `/docs` off in production, generic 500 answers, and sensitive actions limited to 30/min per user.
- The browser talks only to the website; Next.js passes `/api/*` to the backend. No CORS is configured.
- In production the server refuses to start with `COOKIE_SECURE` off, non-`https://` origins, `ALLOWED_HOSTS` unset or `*`, or no `DATABASE_URL`.

**Data integrity**
- Append-only triggers (the database refuses `UPDATE` and `DELETE`) on `audit_events`, `stock_adjustments`, `quality_inspections` and `order_status_history`. `TRUNCATE` and dropping triggers are not blocked.
- Check constraints on stock arithmetic and plan consistency; an exclusion constraint forbids overlapping printer plans.
- Stock changes, reservations and scheduling lock the same rows in the same order (order, printer, materials by id); concurrency tests include a withdrawal racing a reservation.

## 4. OWASP Top 10 (2021): where each area is addressed

A rough map, not a compliance statement.

| | Main controls | Evidence | Residual risk |
|---|---|---|---|
| A01 Broken access control | Permission on every endpoint, mass-assignment blocking | OpenAPI scan: all 34 non-public endpoints answer 401; role and 403 tests | Single-tenant: every permitted user sees all data |
| A02 Cryptographic failures | Argon2id; hashed session and ticket tokens; Secure cookie, HSTS | Cookie flag and hash-only storage tests | TLS and storage encryption are the platform's; the Secure/`__Host-` cookie was not run over real https (7) |
| A03 Injection | ORM bound parameters, escaped LIKE, validated filters, React escaping, CSP | Injection-payload and NUL-byte tests | Dev-only lint advisory (6) |
| A04 Insecure design | Rules in the server, rate limits, append-only history, advisory scheduling | Business-rule tests (see 5) | In-memory rate limits |
| A05 Security misconfiguration | Production start-up check, headers, trusted hosts, docs off, generic errors | Header, host, size and error tests | Inline styles allowed in CSP; platform configuration is the operator's job |
| A06 Vulnerable components | `pip-audit`, `npm audit`, few dependencies | Section 5 | Dev-only advisory (6) |
| A07 Identification and authentication failures | Argon2id, throttling, generic errors, rotation, revocation, expiry, password rules | 23 backend auth tests, 15 browser tests | No multi-factor sign-in; no breached-password check |
| A08 Software and data integrity failures | Append-only history, migrations in source control, lock files | Trigger tests | No signed builds or supply-chain attestation |
| A09 Logging and monitoring failures | Audit trail of sign-ins, denials, user, role, production, QC, release, schedule and stock events | Audit tests; tests that passwords do not appear in audit rows | Nothing alerts on the audit log; no log shipping |
| A10 Server-side request forgery | The server fetches no user-supplied URLs | n/a | The Next.js proxy only talks to the configured `BACKEND_URL` |

## 5. Verification

**5.1 Repeatable checks** (last run during this documentation review; all on this machine, using isolated test databases, never the `mfg` database):

| Check | Command | Result |
|---|---|---|
| Backend tests | `cd backend && .venv/bin/pytest` | 252 passed |
| Browser tests (incl. security, scheduling, resources, axe audit), isolated database and generated admin password | `cd frontend && npm run test:e2e` | 105 passed |
| Typecheck, lint, production build | `npx tsc --noEmit`, `npm run lint`, `npm run build` | pass, no errors or warnings, pass |
| Migrations from an empty database, `alembic check` | `alembic upgrade head`, `alembic check` | 3 revisions applied, "No new upgrade operations detected" (scratch database) |
| Python dependencies | `pip-audit -r requirements.txt` | no known vulnerabilities |
| npm dependencies that ship | `npm audit --omit=dev` | 0 vulnerabilities |

The axe audit (WCAG 2.0/2.1 A and AA rules plus best practices) covers every page, forms with errors, open dropdowns, every dialog, the sign-in page and the phone menu.
Three axe rules (`aria-hidden-focus`, `region`, `page-has-heading-one`) are switched off only while a dropdown menu is open, because they report properties of the modal-overlay pattern; this is stated in `e2e/z-accessibility.spec.ts`.

**5.2 One-off manual checks** (done once during development, not part of the test suite, so not repeated by the commands above):
- the new migration applied to a **copy** of the demo database (13 orders), then used through the API: data intact;
- the production build of the frontend in a real browser under the strict CSP (page, dialog, dropdown, WebSocket): no violations;
- a 100,000-order scratch database for the performance figures in the README;
- a local rehearsal with `ENVIRONMENT=production` on a scratch database: Secure `__Host-` cookie, health check, WebSocket origin/ticket checks, spoofed `X-Forwarded-For` ignored. Not a Railway test.

**5.3 Not verified:** deployment on Railway or any other host; behaviour behind a real reverse proxy (including the correct `TRUSTED_PROXY_HOPS` value and the `healthcheck.railway.app` host); the Secure cookie and HSTS over real HTTPS; load or denial-of-service behaviour; multiple backend replicas;
use with a screen reader; browsers other than Chromium; any independent penetration test.

## 6. Residual risks and limitations

1. **Every account is an administrator** (by design for now), so a stolen account has full access. No multi-factor sign-in, no breached-password check, no e-mail password reset.
2. **Flood and sensitive-action limits are in process memory:** they reset on restart and are not shared between replicas (sign-in and password-change limits are shared, see section 3). IP-based limits are only as good as `TRUSTED_PROXY_HOPS`: if it is 0 behind a proxy, all users share the proxy's address; if wrong, the wrong header entry is used. The per-address sign-in limit can overshoot under a burst; the per-user limits cannot.
   The per-user limit (30 failures per 15 minutes) bounds password guessing for any one account regardless of address.
3. **The backend must be publicly reachable** (the WebSocket connects to it directly). Every endpoint requires a session and permission, but consider restricting the REST paths at the network edge if the platform allows it.
4. **CSP allows inline styles.** Scripts are protected by a nonce; styles are not.
5. **Append-only is enforced by triggers.** A database superuser can drop the triggers or truncate tables, so this is not tamper-proof. Real tamper evidence needs external log shipping or hash chaining. Nothing alerts on the audit log.
6. **Dev-only advisory (GHSA-vfj7-8cjw-p6xm):** `npm audit` on the full tree reports 5 "high" findings in one chain: `eslint-config-next@16.4.0` → `@next/eslint-plugin-next@16.4.0` → `fast-glob@3.3.1` → `micromatch@4.0.8` → `braces@3.0.3` (ReDoS on crafted glob patterns). No patched `braces` was available when checked, and the newest plugin/config still uses the same chain.
   It is lint tooling that does not ship (`npm audit --omit=dev`: 0), and npm's only suggested fix is a breaking downgrade to `eslint-config-next@14.2.35`, so it was left. Re-check when `eslint-config-next` is updated.
7. **`python -m app.seed` is destructive.** It empties orders, printers, materials and related history (not users or audit events). It now needs the database name typed back (or `--yes`), refuses to run when `ENVIRONMENT=production`, refuses a database on another computer unless `--allow-remote` is added (`--yes` only skips the typed confirmation), and refuses unless the database is
   at the latest Alembic revision and never creates tables (it used to, which could leave a schema without the append-only triggers and `alembic_version`; fixed, with a regression test in `tests/test_seed_requires_migrations.py`).
8. **Sessions** are not bound to a device, and a user can hold several at once; only a password change or reset ends the others.
9. **Single-tenant model:** there is no per-object ownership, so every permitted user sees all orders. That would need design work if roles with narrower access are added.
10. **Compliance:** this is a demo. Electronic records and signatures rules for medical manufacturing (for example 21 CFR Part 11) need much more than is here.

## 7. Unverified deployment assumptions

These are what the code and README assume about the hosting platform. None has been tested on Railway.

- TLS is terminated by the platform and the site is served only over `https://`, so the `Secure` / `__Host-` cookie works. (Tests exercise the Secure flag by switching the setting, not over a real https connection.)
- The platform's proxy appends the real client address to `X-Forwarded-For`; the number of proxies in front of the backend is unknown until measured, so `TRUSTED_PROXY_HOPS` must be set from the audit log (README section 13). `FORWARDED_ALLOW_IPS=*` must not be used. Until it is correct, every client may share one address and 20 failed sign-ins from anyone can block everybody's sign-in for 15 minutes; once it is right for the frontend path, requests sent directly to the backend's public address can still forge the entry, which only defeats per-address limits.
- The health check request arrives with host `healthcheck.railway.app` (from Railway's documentation, not tested) and that host is in `ALLOWED_HOSTS`; the private network host name is also in `ALLOWED_HOSTS`.
- The platform lets the frontend and backend each have a public `https://` address, and runs one backend instance (WebSocket events are broadcast within one process).
- The frontend server can reach the backend at `BACKEND_URL` (set at **build** time), and the browser can reach the backend's public address for `wss://` (`NEXT_PUBLIC_WS_URL`, also build time).
- The platform's PostgreSQL ships `btree_gist` and lets the application's database user create it. PostgreSQL 13+ treats it as a trusted extension (a database owner may create it), but this has **not** been checked on Railway; the README (section 3) gives the two queries to run first.
- `ALLOWED_ORIGINS` is exactly the address users type, and `ALLOWED_HOSTS` contains every host name the backend receives requests for (including a private network name if used).

## 8. Deployment checklist

- [ ] `ENVIRONMENT=production`, `DATABASE_URL`, `ALLOWED_ORIGINS` (https), `ALLOWED_HOSTS`, `APP_TIMEZONE` set on the backend; the server starts (it will not with unsafe values).
- [ ] `TRUSTED_PROXY_HOPS` set from the real number of proxies; `ALLOWED_HOSTS` includes `healthcheck.railway.app`; start command is the one in `backend/railway.toml`; `/api/health` reports healthy.
- [ ] Frontend built with `BACKEND_URL` and `NEXT_PUBLIC_WS_URL` (`wss://…`) set.
- [ ] Database backed up; `alembic upgrade head` run once, deliberately; `alembic current` shows `0003_auth_scheduling (head)`.
- [ ] First administrator created with `python -m app.manage create-admin` (hidden prompt); any `INITIAL_ADMIN_PASSWORD` variable removed afterwards.
- [ ] `python -m app.seed` **not** run against real data.
- [ ] Sign in; the Production Board shows "Live updates on"; a sixth attempt after five wrong passwords for a made-up user name is blocked; sign out; the cookie is `Secure` in the browser's developer tools.
