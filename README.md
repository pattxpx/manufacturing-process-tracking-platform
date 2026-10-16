# Manufacturing Process Tracking Platform (demo)

A demo platform for a fictional 3D-printed medical device manufacturer ("Meridian Medical"): orders move through five
production steps on three printers, with material stock, quality inspection, release, printer scheduling, sign-in and an audit trail.

> **Demo prototype. Not a certified medical manufacturing control system.** All data is fictional.
> Security: see [SECURITY_AUDIT.md](SECURITY_AUDIT.md) for what was reviewed, fixed, left open and not verified.
> Nothing here is a claim of OWASP compliance, and there has been no independent penetration test.

## Contents

1. [Key features](#1-key-features) · 2. [Stack and architecture](#2-stack-and-architecture) · 3. [Local setup](#3-prerequisites-and-local-setup) ·
4. [Configuration](#4-environment-variables) · 5. [Database](#5-database-migrations-seeding-backup) · 6. [Admin accounts](#6-admin-accounts-and-passwords) ·
7. [Authentication and roles](#7-authentication-authorization-and-roles) · 8. [Production workflow](#8-production-workflow-and-business-rules) ·
9. [Scheduling](#9-printer-scheduling) · 10. [Resources](#10-resources-and-stock) · 11. [API](#11-api-overview) · 12. [Testing](#12-testing-and-verification) ·
13. [Deployment](#13-deployment) · 14. [Limitations and troubleshooting](#14-known-limitations-and-troubleshooting)

## 1. Key features

- **Orders:** create, search, filter, edit (locked once production starts), never deleted. Server-side pagination.
- **Production board:** five steps, first-in-first-out (FIFO) print queue, three printers, blocked-reason explanations, live updates over a WebSocket.
- **Materials:** products use one or several materials; all are reserved together or not at all; actual use is recorded per material.
- **Quality and release:** pass/fail inspections with full history; release only after all steps are complete and the latest inspection passed.
- **Scheduling:** manual planning of print jobs per printer, with a timeline, overlap protection and delay detection.
- **Resources:** create/edit/deactivate materials; stock changes only through recorded adjustments.
- **Security:** sign-in with server-side sessions, role-based permissions, CSRF protection, authenticated WebSocket, rate limits, audit trail.
- **Interface:** responsive (desktop to phone) and keyboard accessible, with brand colors `#00B5E2` (primary) and `#97D700` (secondary).

## 2. Stack and architecture

| Part | Technology |
|---|---|
| Frontend | Next.js 16 (App Router), TypeScript, Tailwind CSS 4, Radix UI Select and Dialog (the only UI libraries) |
| Backend | Python, FastAPI, SQLAlchemy 2, Alembic, Argon2 (`argon2-cffi`) |
| Database | PostgreSQL (needs the bundled `btree_gist` extension) |
| Tests | pytest, Playwright (with `@axe-core/playwright`) |

```
Browser ──HTTPS──▶ Next.js website ──/api/* proxied──▶ FastAPI ──▶ services (business rules) ──▶ PostgreSQL
   │                                                     ▲
   └────────── WebSocket (ticket + Origin check) ────────┘   notify() after each committed change
```

- The browser talks only to the website; Next.js passes `/api/*` to the backend (`frontend/next.config.ts`), so the session cookie is first-party and no CORS is configured.
  The WebSocket connects to the backend directly (`NEXT_PUBLIC_WS_URL`).
- `backend/app/routes/` thin endpoints · `backend/app/services/` business rules · `backend/app/auth/` passwords, sessions, permissions, rate limiter ·
  `backend/app/models.py`, `schemas.py` · `backend/alembic/` migrations · `backend/app/manage.py` operator commands.
- `frontend/app/` pages · `frontend/components/` shared components · `frontend/lib/` API client, auth, live updates · `frontend/proxy.ts` CSP and sign-in redirect.
- The WebSocket only says "something changed" (events: `order.created`, `order.updated`, `production.started`, `production.completed`, `machine.updated`, `resource.updated`,
  `schedule.updated`, `inspection.recorded`, `order.released`). Pages re-fetch from the REST API, which is the source of truth, and refresh after a reconnect.
- **Interface notes:** design tokens (brand colors, radii) are CSS variables in `frontend/app/globals.css`. `#00B5E2` is too light for white text, so buttons on it use dark text and links/focus rings use darker tones of
  the same hue. Status is always shown with a word and a symbol, not color alone. Lists are paged by the server, search is debounced (300 ms), and the board draws the first 25 orders per step
  ("Show more" for the rest) while the server still decides eligibility over the whole queue.

## 3. Prerequisites and local setup

**Prerequisites:** Python 3.11+ (developed on 3.13), Node.js 20+ and npm, PostgreSQL 14+ running locally.
The database user must be allowed to run `CREATE EXTENSION btree_gist` (the migration and the tests do this; it is a standard contrib extension).
On PostgreSQL 13 and later `btree_gist` is a *trusted* extension, so the owner of the database can create it without being a superuser. Whether a particular host (Railway included) ships the contrib extensions and which role you connect as has **not** been checked; before the first migration run `SELECT name FROM pg_available_extensions WHERE name = 'btree_gist';` (one row expected) and `SELECT rolsuper FROM pg_roles WHERE rolname = current_user;`. If `CREATE EXTENSION` is refused, the migration stops and nothing is half-applied; fix the permission and run it again.

```bash
createdb mfg            # the app database. The tests use mfg_test and the browser tests mfg_e2e (see section 12)
```

**Backend** (fresh database; for an existing database see [section 5](#5-database-migrations-seeding-backup)):

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt     # runtime + test tools (production uses requirements.txt)
[ -f .env ] || cp .env.example .env              # creates .env only if it does not exist yet; then edit DATABASE_URL if needed
.venv/bin/alembic upgrade head                    # create the tables
.venv/bin/python -m app.seed                      # optional: demo orders, printers, materials. Asks you to type the database name first
.venv/bin/python -m app.manage create-admin --username alice --full-name "Alice Example"   # asks for a password
.venv/bin/uvicorn app.main:app --reload --port 8000 --no-server-header
```

**Frontend** (second terminal):

```bash
cd frontend
npm install
[ -f .env.local ] || cp .env.example .env.local   # only if it does not exist yet; BACKEND_URL and NEXT_PUBLIC_WS_URL (defaults match the commands above)
npm run dev
```

The `[ -f … ] || cp …` form never overwrites an existing `.env` / `.env.local`; if one exists, compare it with the `.env.example` template and add any missing variables by hand.

Open http://localhost:3000 and sign in with the account you created. There is **no default account**: until `create-admin` has been run nobody can sign in.
In development the API documentation is at http://localhost:8000/docs (it is off in production).

## 4. Environment variables

Backend, in `backend/.env` (template: `backend/.env.example`, placeholders only; real values are never committed):

| Variable | Default | Purpose |
|---|---|---|
| `ENVIRONMENT` | `development` | `production` makes the server **refuse to start** if the settings below are unsafe |
| `DATABASE_URL` | `postgresql+psycopg://localhost:5432/mfg` | Database URL. The `postgresql://` and `postgres://` forms that hosting platforms give out are accepted and switched to the `psycopg` driver. Required in production |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | The website's address, exactly as in the browser. Checked on state-changing requests and WebSocket connections. Production: `https://` only |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | Host names the backend answers to. Production: must be set, never `*` |
| `COOKIE_SECURE` | `true` in production, else `false` | Secure flag (and `__Host-` name) of the session cookie. Must be on in production |
| `APP_TIMEZONE` | `UTC` | Time zone for **display** and for the schedule form (IANA name, e.g. `Asia/Bangkok`). Stored times are always UTC |
| `SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS` | `120`, `12` | Sign-out after this much inactivity / in total |
| `TRUSTED_PROXY_HOPS` | `0` | How many reverse proxies in front of the server add the client's address to `X-Forwarded-For`. `0` ignores the header (the connecting address is used). See section 13 |
| `API_RATE_LIMIT_PER_MINUTE` | `1800` | Requests per client address per minute (per server process) |
| `MAX_BODY_BYTES` | `1000000` | Largest request body |
| `ENABLE_API_DOCS` | off in production | `/docs` and `/openapi.json` |
| `TEST_DATABASE_URL` | `.../mfg_test` | pytest database. The name must end in `_test`: the tests drop all tables |
| `INITIAL_ADMIN_PASSWORD` | – | Optional, read **only** by `python -m app.manage` for non-interactive use. Prefer the hidden prompt; never put it in a committed file |

Frontend, in `frontend/.env.local` (template: `frontend/.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `BACKEND_URL` | `http://localhost:8000` | Where the Next.js **server** reaches the backend. Read at **build** time |
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:8000/ws/production/` | The backend's WebSocket as the **browser** reaches it (`wss://` in production). Read at **build** time; also used in the CSP |

Server-process setting that is not an application variable: the `uvicorn` flag `--no-server-header`. Do **not** set `FORWARDED_ALLOW_IPS=*`: uvicorn would then believe the left-most `X-Forwarded-For` entry, which a client can choose (use `TRUSTED_PROXY_HOPS` instead).
Playwright: `E2E_DATABASE_URL` (default `.../mfg_e2e`); the test administrator's password is generated per run.

## 5. Database: migrations, seeding, backup

Migrations are in `backend/alembic/versions/`: `0001_initial_schema`, `0002_multi_material`, `0003_auth_scheduling` (current head). Run every command from `backend/`.

**Fresh database:** `createdb mfg` → `alembic upgrade head` → optionally `python -m app.seed` → `python -m app.manage create-admin ...`.

**Upgrading an existing database** (for example one created before sign-in existed):

```bash
pg_dump mfg > mfg-backup.sql          # 1. back up first
.venv/bin/alembic current             # 2. what revision is it at now?
.venv/bin/alembic upgrade head        # 3. upgrade
.venv/bin/alembic current             # 4. expect: 0003_auth_scheduling (head)
.venv/bin/alembic check               # 5. expect: No new upgrade operations detected
.venv/bin/python -m app.manage create-admin --username alice --full-name "Alice Example"
```

The migrations are additive and reversible (`alembic downgrade -1`). Downgrading `0003` deletes users, sessions, the audit trail, stock adjustments and plans, and downgrading `0002`
is refused by the database once multi-material jobs exist. Existing orders, history and stock are kept; old history rows get the actor `system`, and the demo materials get a category.
Until the migration has run, the current code cannot work with an older schema (requests fail with database errors).
To restore a backup: create an empty database and `psql -d NEWDB -f mfg-backup.sql`.

> **`python -m app.seed` deletes data, so it asks first.** It prints what it is about to delete (counts, database name and host) and waits for you to **type the database name**; without a terminal it refuses unless you add `--yes`. **`--yes` skips that confirmation entirely** (the data is deleted at once), so use it only in scripts and tests.
> It refuses always with `ENVIRONMENT=production`, and refuses a database on another computer (a host other than localhost) unless you also add `--allow-remote`. Neither guard is a substitute for care: if `ENVIRONMENT` is unset on a deployed service, only the remote-host check stands in the way. It empties order history, inspections, material usage, production records, stock adjustments, **orders, printers and materials**
> (ids restart), then recreates 3 printers, the 5 materials with their default stock, and (without `--empty`) 12 demo orders. It does **not** delete users, sessions or audit events.
> Never run it on a database whose orders or stock you want to keep, and never on production. `--empty` skips the demo orders but still empties everything above.
> The seed never creates tables: Alembic is the only thing that does. It **refuses to run** (and changes nothing) unless the database is at the latest migration, and tells you to run `alembic upgrade head` first.
> This guarantees the migrations' append-only triggers and the `alembic_version` table are always present.

## 6. Admin accounts and passwords

| Task | Command (from `backend/`) |
|---|---|
| Create the first administrator | `.venv/bin/python -m app.manage create-admin --username alice --full-name "Alice Example"` |
| Set a new password for an existing user | `.venv/bin/python -m app.manage reset-password --username alice` (ends all of that user's sessions) |

- The command asks for the password twice at a hidden prompt. It never accepts a password as an argument and never prints or logs it.
- Non-interactive use (automation, one-off deploy jobs): set `INITIAL_ADMIN_PASSWORD` **for that command only**, then remove it. It is not an application setting.
- Password rules: 12–128 characters, not containing the user name, not trivially repetitive. Stored as Argon2id hashes.
- After that, administrators create further accounts in the app (**Users**), and anyone can change their own password on the **Account** page.
- The seed script and the migrations never create accounts. If a hosted demo needs shared credentials, create the accounts with these commands and hand them out separately; none are written down in this repository.

## 7. Authentication, authorization and roles

Summary (the verification and the open risks are in [SECURITY_AUDIT.md](SECURITY_AUDIT.md)):

- **Sessions:** server-side. The browser holds a random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` and named `__Host-session` when `COOKIE_SECURE` is on); the database stores only its SHA-256 hash.
  Each login creates a new session. Sessions end after `SESSION_IDLE_MINUTES` idle or `SESSION_MAX_HOURS` in total, on logout, password change (other sessions), password reset, role change and deactivation.
  The CSRF token is returned by login and `GET /api/auth/me` and kept in page memory; nothing secret is stored in `localStorage`.
- **CSRF:** every `POST/PUT/PATCH/DELETE` needs the `X-CSRF-Token` header and an allowed `Origin` (a cross-site `Sec-Fetch-Site` is also refused).
- **Rate limits:** failed sign-ins are counted per user+address (5), per address (20) and per user (30) within 15 minutes, then answered with 429 and `Retry-After`; failed password changes (5 per 15 minutes) likewise.
  These counts are read from the audit trail **in the database**, so they are the same on every server instance and survive restarts. Creating or changing users, materials and stock, and planning print jobs, are limited to 30 per minute per user,
  and `/api` to `API_RATE_LIMIT_PER_MINUTE` per address; those two flood limits are kept in each server process's memory (per instance, reset on restart).
- **WebSocket:** needs a single-use 30-second ticket (`POST /api/auth/ws-ticket`, sent as a subprotocol) and an allowed `Origin`; the user needs `production:read`; at most 10 sockets per user;
  the login is re-checked every 30 seconds and logout closes the sockets.
- **Authorization:** every endpoint except `GET /api/health` and `POST /api/auth/login` requires a session **and** one named permission (`backend/app/auth/permissions.py`). The frontend only hides what a user may not use.
- **Request bodies** reject unknown fields, and who did something always comes from the session.
- **Audit trail** (`GET /api/audit-events`, **Audit log** page): sign-ins (including failed and blocked), sign-outs, permission denials, user and role changes, password changes/resets, orders, production steps,
  inspections, releases, schedule changes, resource changes and stock adjustments. The audit table, stock adjustments, inspections and order history are append-only at the database level (triggers; `TRUNCATE` is not blocked).

**Roles today: every account is an `admin`, and `admin` has every permission.** New accounts default to `admin`; there is no public registration; only a user with `users:manage` can create accounts or change roles;
a role that is not defined has no permissions; the last user who can manage users cannot be deactivated or demoted.

**Adding a restricted role later:** add an entry to `ROLE_PERMISSIONS` in `backend/app/auth/permissions.py`, for example
`"quality_inspector": frozenset({ORDERS_READ, PRODUCTION_READ, QUALITY_READ, QUALITY_INSPECT})`. The role then appears in the Users screen and every endpoint already enforces its permission.
Add tests for it: `backend/tests/test_authorization.py` shows how (a read-only role is defined in a fixture and every forbidden call is checked).
Permissions: `orders:read|write`, `production:read|operate`, `schedule:read|manage`, `resources:read|manage`, `stock:adjust`, `quality:read|inspect|release`, `users:manage`, `audit:read`.

## 8. Production workflow and business rules

All rules are enforced in the backend (the frontend only displays them).

- **Steps** run in order: Design Review → 3D Printing → Post-processing → Quality Inspection → Final Release. Skipping or repeating a step is rejected.
  Inspection and release have their own endpoints.
- **Printers:** three, one job each. A busy printer is rejected; with no printer given, the first free one is used (the planned printer first, see section 9).
- **Materials:** a product lists one or more materials with a per-unit amount (`backend/app/catalog.py`). Starting printing reserves **all** of them or none, and reports every shortage and any inactive material.
  Completing records the actual use per material (omitted = reserved amount; more than reserved is rejected) and releases the whole reservation. A job can never consume a material twice.
- **FIFO:** an order cannot start printing while an older waiting order exists that could start. An older order blocked by material does not hold others up.
- **Concurrency:** start, complete, adjust and schedule run in one transaction with row locks in a fixed order (order, printer, materials by id). Database constraints are the last line of defence.
- **Editing:** everything is editable while an order is `New`; afterwards order number, product, quantity and design reference are locked (notes stay editable). Released orders are read-only. Orders are never deleted.
- **Quality:** inspections are only added. A failed inspection (notes required) blocks release until a later inspection passes. **Release** needs steps 1–4 complete and the latest inspection to be a pass.
- **History:** every step, status change and edit is written to the order's history with the user who did it.

**Fictional products** (two use several materials):

| Product | Materials per unit |
|---|---|
| Titanium Spinal Cage | 40 g Ti-6Al-4V Powder |
| Cranial Implant Plate | 120 g Ti-6Al-4V Powder + 12 L Argon Gas |
| Orthopedic Knee Insert | 85 g PA12 Medical Nylon Powder |
| Custom Surgical Guide | 60 ml Medical Photopolymer Resin + 20 ml Isopropyl Alcohol |
| Hearing Aid Shell | 8 ml Medical Photopolymer Resin |

**Try it (after `app.seed`):** sign in → **Production Board** → start and complete Design Review, then **Start…** on 3D Printing (choose a printer; the dialog lists the materials to reserve) →
**Complete** enters the actual use per material → Post-processing → **Quality & Release**: Fail needs notes and blocks release, Re-inspect and pass, Release.
`ORD-1009` needs more titanium and argon than is in stock, so it is blocked and lists both shortages without blocking `ORD-1010`.
Open the board in two windows to see live updates.

## 9. Printer scheduling

Manual planning only: no machine integration and no optimisation. **Schedule** page, and **Plan print** on an order.

- A plan is a printer, a start time and an estimated duration; the end is start + duration. Stored in UTC (`planned_start_at`, `estimated_duration_minutes`, `planned_end_at`),
  shown in `APP_TIMEZONE`. The form takes local time in that zone; the API requires a time zone on every time it receives.
- **Planned and actual are separate:** actual times are the production records. The plan is kept after the job has run.
- **States** (derived, never typed in): Planned, Running, Delayed (planned start passed without starting, or running past the planned end), Completed.
- **No overlaps on a printer:** checked under a row lock, and guaranteed by a database exclusion constraint. Back-to-back is allowed. A plan stops holding its slot when printing completes.
- **Who can be planned:** orders that are not released and have not started printing; materials must be active and in stock (on hand).
- **Plans are advisory:** they never start a job, reserve material or change FIFO. The only effect on production is that starting without a chosen printer prefers the planned printer when it is free.

## 10. Resources and stock

**Resources** page: create (name, category, unit, minimum stock, optional opening stock), edit details, activate/deactivate, adjust stock, view stock history.

- Units `g, kg, ml, L, pcs`; categories `powder, resin, gas, solvent, other`; names unique (case-insensitive). A **low-stock** warning shows when available stock is below the minimum.
- **Editing never changes quantities** (the API refuses quantity fields). Quantities change only through **stock adjustments**: a signed amount, a required reason, the user and time, kept permanently.
  Opening stock is the first adjustment. Removing more than the *available* amount (on hand − reserved) is refused, under the same row lock that reservations use.
- Materials are never deleted. Deactivation is refused while stock is reserved; an inactive material blocks the jobs that need it.
- The unit can only change while the material has no reservation, usage or adjustment history. Materials that product definitions use cannot be renamed.
- Which materials a product uses is defined in code (`catalog.py`): new materials can be tracked and stocked, but a new product is a code change.

## 11. API overview

Interactive documentation is available only when `ENABLE_API_DOCS` is on (development). Main endpoints (all need sign-in unless noted):

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/login` (public), `/logout`, `GET /api/auth/me`, `POST /api/auth/change-password`, `/ws-ticket` · `GET /api/health` (public) |
| Users, audit | `GET/POST /api/users`, `PATCH /api/users/{id}`, `POST /api/users/{id}/reset-password`, `GET /api/users/roles` · `GET /api/audit-events` |
| Orders | `GET /api/orders` (paged: `page`, `page_size` ≤ 100, `search`, `status`, `step`), `POST /api/orders`, `GET/PATCH /api/orders/{id}`, `GET /api/products`, `GET /api/dashboard` |
| Production | `POST /api/orders/{id}/steps/{step}/start` and `/complete`, `GET /api/production/queue`, `GET /api/production/board?limit=25`, `GET /api/machines` |
| Scheduling | `GET /api/schedule`, `PUT/DELETE /api/orders/{id}/schedule` |
| Resources | `GET/POST /api/resources`, `PATCH /api/resources/{id}`, `GET/POST /api/resources/{id}/adjustments`, `GET /api/resources/usage` (paged) |
| Quality | `GET /api/inspections` (paged), `GET /api/inspections/pending` (paged), `POST /api/orders/{id}/inspections`, `POST /api/orders/{id}/release` |

Paged lists return `{items, total, page, page_size, total_pages}` in a stable order. A page past the end returns the last page, and invalid `page`/`page_size` (below 1, or `page_size` above 100) give HTTP 422.
The production board lists the oldest 25 orders per step (running ones first, "Show more" up to 200); which orders may start is always decided over the whole queue on the server.

## 12. Testing and verification

One-time preparation: `createdb mfg_test` and `createdb mfg_e2e`, and `cd frontend && npx playwright install chromium`.

| Check | Command | Notes |
|---|---|---|
| Backend tests | `cd backend && .venv/bin/pytest` | 252 tests, uses `mfg_test` (dropped and recreated per test), about 45 s |
| Browser tests | `cd frontend && npm run test:e2e` | 105 tests in 11 files. Starts its own backend (port 8100, database `mfg_e2e`; orders are reset at start, accounts are kept) and frontend (port 3100), creates a test administrator with a random password. Needs ports 3100 and 8100 free |
| Typecheck | `cd frontend && npx tsc --noEmit` | |
| Lint | `cd frontend && npm run lint` | |
| Production build | `cd frontend && npm run build` | |
| Migration drift | `cd backend && .venv/bin/alembic check` | against a database that is at head |
| Python dependencies | `cd backend && .venv/bin/pip-audit -r requirements.txt` | |
| npm dependencies | `cd frontend && npm audit --omit=dev` | |

The browser tests include an automated axe accessibility audit of every page and dialog. Automated checks find only part of the problems; nothing was tested with a screen reader.
The tests never touch the `mfg` database. The results of the last full run are recorded in [SECURITY_AUDIT.md](SECURITY_AUDIT.md#5-verification).

## 13. Deployment

The application itself is platform-neutral: it reads plain environment variables (section 4), needs only PostgreSQL and two long-running processes, and contains no Railway-specific code. Railway is the primary target, so `backend/railway.toml` and `frontend/railway.toml` are provided; other platforms ignore them.

### 13.1 What any platform must provide

- **Two services:** the backend (`uvicorn app.main:app --host 0.0.0.0 --port $PORT --no-server-header`, health check `GET /api/health`) and the frontend (`npm run build`, then `next start -H 0.0.0.0`, health check `GET /login`; Node 20.9+, Python 3.11+ for the backend).
- **PostgreSQL 14+** with the `btree_gist` extension, and a database user allowed to create it (section 3).
- **HTTPS on both public addresses.** Cookies are `Secure`/`__Host-`, so plain http does not work in production. The backend needs a **public** address as well, because the browser opens the WebSocket to it directly.
- **Backend variables:** `ENVIRONMENT=production`, `DATABASE_URL` (`postgresql://` or `postgres://` is accepted and switched to the `psycopg` driver), `ALLOWED_ORIGINS` (the frontend's `https://` address, exactly as typed), `ALLOWED_HOSTS` (every host name the backend receives: its public name, a private name if the frontend uses one, and the platform's health-check host), `APP_TIMEZONE`, `TRUSTED_PROXY_HOPS` (below). The server refuses to start in production with unsafe values.
- **Frontend variables, set before the build** (Next.js bakes them in; changing them at run time has no effect): `BACKEND_URL` (where the frontend server reaches the backend) and `NEXT_PUBLIC_WS_URL` (`wss://<backend public host>/ws/production/`).
- **Proxy facts you must find out for your platform:** how many proxies append to `X-Forwarded-For` (`TRUSTED_PROXY_HOPS`, measured as in 13.3) and which host name the health check sends.
- Run migrations and create the first administrator once, deliberately (13.4). Never run the seed on real data.

### 13.2 What is verified and what is not

**Checked locally** (against scratch databases, simulating the platform; see [SECURITY_AUDIT.md](SECURITY_AUDIT.md#5-verification)): production-mode start-up and its refusals; the exact backend start command from `backend/railway.toml`; both `railway.toml` files parse; the frontend start command from its file serves `/login` with `$PORT`, also for the host `healthcheck.railway.app`, with HSTS and a CSP; `postgresql://` URLs; `/api/health` (200 and 503); Host and Origin rules; the Secure `__Host-` cookie; WebSocket origin, ticket and re-use rules; address resolution from `X-Forwarded-For`.

**Not verified; nothing has been deployed to Railway.** These can only be completed there (13.5): the build and start on Railway, the health-check host name (taken from Railway's documentation), the private network address, real HTTPS and HSTS, the WebSocket through Railway's edge, the correct `TRUSTED_PROXY_HOPS`, the PostgreSQL version, whether `btree_gist` can be created, and the database user's rights.

### 13.3 Railway guide

Create three things in one project; secrets are service variables in the dashboard, never in the repository.

1. **PostgreSQL service.** Add Railway's PostgreSQL. Before anything else, check it from a machine that can reach it (`psql` with the connection URL from the dashboard; this changes nothing):
   ```sql
   SHOW server_version;                                   -- 14 or later expected
   SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name = 'btree_gist';  -- one row expected
   SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user;
   SELECT has_database_privilege(current_database(), 'CREATE');  -- must be true
   ```
   PostgreSQL 13+ treats `btree_gist` as a trusted extension, so a database owner can usually create it, but this is not confirmed for Railway. If the extension is missing or `CREATE` is refused, stop: the migration cannot succeed until that is fixed. Do not work around it by editing the migration.
2. **Backend service** (root directory `backend`; settings come from `backend/railway.toml`). Variables as in 13.1. `DATABASE_URL` is Railway's reference to the database service's URL. Give it a public domain. Put into `ALLOWED_HOSTS`: that domain, `healthcheck.railway.app`, and the private host name if you use it (without port). Leave `TRUSTED_PROXY_HOPS` at `0` for now.
3. **Frontend service** (root directory `frontend`; settings come from `frontend/railway.toml`). Set `BACKEND_URL` and `NEXT_PUBLIC_WS_URL` **before the first build**, then give it a public domain and put that `https://` address into the backend's `ALLOWED_ORIGINS`.

**Determine `TRUSTED_PROXY_HOPS` (do not guess it).** Rate limits and the audit trail need the real client address. Behind proxies the connecting address is the proxy's, and `X-Forwarded-For` can also be written by the client. Each proxy appends to the **right**; with `TRUSTED_PROXY_HOPS=N` the app uses the N-th entry from the right and ignores everything to its left (a missing, short or malformed header falls back to the connecting address). Never set uvicorn's `FORWARDED_ALLOW_IPS=*`: it believes the left-most, client-written entry. Measure N after the first deployment:

1. Deploy with `0`. Find your real public address from a source other than the app (a "what is my IP" page, from the same network).
2. Send a failed sign-in through the **public frontend address** with a made-up user name and a forged header (the forged address is documentation-reserved; the request is refused with 401):
   ```bash
   curl -s -o /dev/null -H 'X-Forwarded-For: 203.0.113.99' -H 'Content-Type: application/json' -d '{"username":"probe-nobody","password":"wrong-password-1"}' https://<frontend host>/api/auth/login
   ```
3. In the **Audit log** (signed in as an administrator) read the `ip` of that `login_failed` event. At `0` it is a proxy's private address. Raise `TRUSTED_PROXY_HOPS` by one, restart, repeat the probe, and continue until the logged address **is your real address**. The correct N is the smallest value where that is true. If the logged address is ever `203.0.113.99`, N is too high: that entry came from the client.
4. Repeat with a different forged address: the logged address must not change. If it does, do not use that value.

Limits: the count can differ between paths. The value measured through the frontend does not apply to requests sent straight to the backend's public address (the WebSocket does that), where an attacker can write the entry a larger N selects; that only lets them evade the *per-address* limits (per-user limits do not use addresses). While N is lower than the truth (including `0`), every client shares one address, so 20 failed sign-ins from anyone block sign-in for **everybody** for up to 15 minutes. Setting N correctly matters.

### 13.4 First deployment (run once, deliberately; nothing here is automatic)

From a machine that can reach the database, using the backend service's variables (Railway's CLI can run a command with them; the exact way is Railway's, not tested here):

1. Back up the database if it holds data. Run the checks in 13.3 step 1. Then `alembic upgrade head` and `alembic current` (expect `0003_auth_scheduling (head)`).
2. `python -m app.manage create-admin --username <name> --full-name "<name>"` and type the password at the hidden prompt.
3. Do **not** run `python -m app.seed` against real data. It refuses while `ENVIRONMENT=production`, and refuses non-local databases without `--allow-remote`.

### 13.5 Checks to complete on Railway before production use

- [ ] Both builds succeed and both health checks turn green (if the backend's fails with HTTP 400, `healthcheck.railway.app` is missing from `ALLOWED_HOSTS`).
- [ ] HTTPS: `curl -sI https://<frontend host>/login` shows `Strict-Transport-Security` and a `Content-Security-Policy` whose `connect-src` contains your `wss://` backend address (if not, `NEXT_PUBLIC_WS_URL` was set after the build: rebuild).
- [ ] Sign in; in the browser tools the cookie `__Host-session` is `Secure` and `HttpOnly`; sign out ends the session.
- [ ] WebSocket: the Production Board shows "Live updates on", the browser's network tab shows a `wss://` request with status 101, and a wrong origin is refused:
      `curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Protocol: mfg-v1, ticket.invalid' https://<backend host>/ws/production/` should print `403`.
- [ ] `TRUSTED_PROXY_HOPS` measured as in 13.3 and set.
- [ ] A sixth failed sign-in for a made-up user name gives the lock-out message (use a name that is not a real account).
- [ ] `/docs` is not served; a request with a wrong `Host` header is refused.
- [ ] Only one backend instance is running (see the WebSocket limitation in section 14).

## 14. Known limitations and troubleshooting

**Limitations**

- **All accounts are administrators** (by design for now). No multi-factor sign-in, e-mail password reset, or alerting on the audit log.
- **Rate limiting:** sign-in and password-change throttling is shared by all instances (it is counted in the database); the flood limit (`/api` per address) and the 30-per-minute limit on sensitive actions are per server process. Attempts for one user are serialised by a database lock, so a burst cannot overshoot that user's limit; the per-address limit can overshoot by the number of requests in flight. If the database is down, sign-in fails (HTTP 500) rather than letting anyone in. Address-based limits are only as good as `TRUSTED_PROXY_HOPS` (section 13).
- The CSP locks scripts to a per-request nonce but allows inline **styles**.
- Planning and printing are manual: no machine integration, delay is computed from the clock, and there are no timers or failures.
- Products and per-unit material amounts are defined in code; quantities are whole numbers; actual use cannot exceed the reservation; all of a product's materials are reserved when printing starts.
- Text search is a substring search (about 130 ms at 100,000 orders; a trigram index would be needed beyond that). The orders list cannot be sorted by column.
  `GET /api/production/queue` without `limit_per_step` returns every waiting order. A new order joins the end of the FIFO queue, so it may not be on the board until "Show more" is used.
- WebSocket events are broadcast within one backend process; several replicas would need a shared broker.
- Measured once on a scratch database of 100,000 synthetic orders (not part of the test suite): the dashboard in about 0.1 s, one page of orders in about 10 ms, the board in about 0.1 s, starting a print in about 30 ms.
- **Dev-only npm advisory:** `npm audit` (full tree) reports 5 high findings, all one chain `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces` (GHSA-vfj7-8cjw-p6xm, ReDoS on crafted glob patterns). It is lint tooling that is not shipped (`npm audit --omit=dev` reports 0). No patched `braces` exists and npm's only suggested fix is a breaking downgrade of `eslint-config-next`, so it is left; see [SECURITY_AUDIT.md](SECURITY_AUDIT.md).
- Not a certified medical manufacturing system: no electronic-signature or traceability controls.

**Troubleshooting**

| Symptom | Likely cause and fix |
|---|---|
| `relation "users" does not exist`, or other database errors after pulling new code | The migration has not run: compare `alembic current` with `alembic heads`, then `alembic upgrade head` (back up first) |
| `permission denied to create extension "btree_gist"` | Ask a database administrator to run `CREATE EXTENSION btree_gist;` once in that database |
| Cannot sign in; "Too many failed sign-in attempts" (429) | Wait for the `Retry-After` time (counters last 15 minutes; restarting the backend clears them). Forgotten password: `python -m app.manage reset-password` |
| Signed out immediately after sign-in on an `https` deployment | The cookie is `Secure`: the site must really be served over `https`. Check `COOKIE_SECURE` and that you open the `https://` address |
| 403 "Request origin not allowed" | `ALLOWED_ORIGINS` must equal the address in the browser's address bar exactly (scheme, host, port) |
| 400 "Invalid host header" | Add the backend's host name to `ALLOWED_HOSTS` |
| "Reconnecting…" instead of "Live updates on" | `NEXT_PUBLIC_WS_URL` is wrong (it is fixed at build time), the backend is not reachable from the browser at that address, or `ALLOWED_ORIGINS` does not match |
| "Cannot reach the server" in the web app | `BACKEND_URL` is wrong or the backend is down (set at build time) |
| Browser tests fail to start ("webServer was not able to start") | Another process uses port 3100 or 8100, or `mfg_e2e` does not exist: `lsof -i :3100 -i :8100`, `createdb mfg_e2e` |
| Backend tests refuse to run | `TEST_DATABASE_URL` must end in `_test` |
| Health check fails on Railway (HTTP 400) | `healthcheck.railway.app` is missing from `ALLOWED_HOSTS` |
| Seeding says "No terminal to confirm on" or "Cancelled" | By design: run it in a terminal and type the database name, or add `--yes` (skips the confirmation). It never runs with `ENVIRONMENT=production`, and needs `--allow-remote` for a non-local database |
| All visitors share one address in the audit trail | `TRUSTED_PROXY_HOPS` is `0` (the default) or too low. See section 13 |
| `The database is at revision … but the latest is …` when seeding | Run `alembic upgrade head` first (from `backend/`), then seed again |
