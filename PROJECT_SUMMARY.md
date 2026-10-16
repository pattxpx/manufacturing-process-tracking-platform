# Project Summary: Manufacturing Process Tracking Platform

**Purpose.** A working demo that follows a 3D-printed medical device order from creation to release, with rules enforced in the backend. Fictional data only; not a certified manufacturing system.

## Requirements → features

| Requirement | Where it is built |
|---|---|
| Dashboard (counts, steps, printers, materials, activity) | `/` · `GET /api/dashboard` |
| Orders: search/filter, create, view, edit, locking, no delete | `/orders`, `/orders/new`, `/orders/[id]` · `services/orders.py` |
| Production board, 5 steps, FIFO queue, 3 printers, blocked reasons | `/production` · `services/production.py` |
| Resources: reserve every material on start, deduct per-material actual use on completion, usage history | `/resources`, `CompletePrintingDialog` · `resource_usage` table (one row per job and material) |
| Quality & release: pass/fail, history, release gate | `/quality` · `services/quality.py` |
| WebSocket updates + reconnect with REST refresh | `/ws/production/` · `frontend/lib/live.tsx` |
| Large data | Server-side pagination (orders, usage and inspection history, QC lists), 300 ms debounced search, a capped board, database-counted dashboard. Measured once on a 100,000-order scratch database (not part of the test suite). |
| Security | Sign-in with server-side sessions and Argon2id, CSRF protection, role-based permissions on every endpoint (all accounts are admins for now), authenticated WebSocket, rate limits, security headers and CSP, append-only audit trail. See SECURITY_AUDIT.md |
| Scheduling | Manual planning of print jobs on the three printers (planned times kept apart from actual ones, no overlaps, shown in the configured time zone), a Gantt-style timeline |
| Resources | Create, edit and deactivate materials; stock only changes through recorded adjustments (reason, user, time, append-only) |
| Deployment | Platform-neutral configuration through environment variables; Railway is the primary target (`railway.toml` for each service, README section 13). **Not yet deployed or verified on Railway**; the README lists the checks to complete there (including measuring `TRUSTED_PROXY_HOPS`). Known limits: process-local API flood limit, single-instance WebSocket broadcast, inline styles in the CSP, a dev-only npm advisory |
| Tests | 252 pytest tests, 105 Playwright tests (workflows, security, scheduling, resources, pagination, dropdowns, keyboard and cursor, layout at 4 screen sizes, axe accessibility audit) |

## Design decisions

- **Simple state model.** An order has a `current_step` and a `status`. One `production_records` row per order per step records what happened. A few derived properties on the model (`step_state`, `release_blockers`, `can_edit`) are returned by the API, so the UI shows backend decisions instead of repeating the rules.
- **Rules live in a small service layer**, one file per area. Routes stay thin. Errors are a single `BusinessRuleError` turned into a JSON message (409/404/422).
- **Concurrency by row locks.** Start/complete lock the order, printer and material rows inside one transaction, always in the same order (materials sorted by id), so requests cannot deadlock. CHECK constraints and unique indexes (one running job per printer, one usage row per job and material, actual ≤ reserved) back this up at database level.
- **Multi-material products.** A product lists its materials and per-unit amounts in code. Starting a job reserves all of them or none and reports every shortage. Completing records actual use per material (omitted ones default to the reservation, above-reservation is rejected) in one all-or-nothing step. Two products use several materials, the other three use one, so both cases are exercised. Completion works from the reservations that exist, so jobs started before the upgrade still complete.
- **WebSocket = notification only.** Any event makes pages re-fetch via REST, so there is one source of truth and recovery after a disconnect is trivial.
- **Plain strings instead of database enums** (with CHECK constraints) keep migrations simple.
- **Security first, then features.** The security audit came before the new code. Authentication uses plain server-side sessions (random token, hash stored) with Argon2id, behind a same-origin proxy so the cookie is first-party. Every endpoint needs a named permission, so roles can be added later without touching the endpoints. The database itself refuses to change history tables.
- **Planning is advisory.** A plan is an estimate; it never starts a job, reserves material or changes the FIFO order. Starting follows the same rules as before, and only prefers the planned printer when it is free.
- **No UI component library**, to keep the prototype small. The only UI dependencies are Radix Select and Radix Dialog, used for accessible dropdowns and dialogs instead of hand-building them. See *Known limitations* in the README, and SECURITY_AUDIT.md for what is not covered.
- **Large data.** Lists are paged by the database. The board only draws the first 25 orders per step, but eligibility and FIFO are always decided over the whole queue on the server, so a display limit can never change what may start. Query plans were checked at 100,000 orders; no new index was needed.
- **Design system.** Brand colors (`#00B5E2` primary, `#97D700` secondary) are CSS variables. Text on the primary color is dark for contrast, status colors stay separate and always come with a word and a symbol. On phones tables become stacked cards and the board shows one step at a time.
- **FIFO scope.** Enforced for the printing queue only, where orders compete for printers and material. An older order blocked by material never blocks newer orders.

## Quick user guide

1. Follow the README setup: PostgreSQL, `alembic upgrade head`, optionally the demo seed (it deletes orders, printers and materials), create the first administrator with `python -m app.manage create-admin`, start backend and frontend, then sign in. There are no default accounts.
2. Create an order on **Orders → New order**.
3. On the **Production Board**, Start/Complete Design Review, 3D Printing (printer and materials are handled for you; the completion dialog asks for the actual use of each material) and Post-processing.
4. On **Quality & Release**, record an inspection. A Fail blocks release; re-inspect and pass.
5. **Release** the order. It is now read-only. Check **Resources** for the material it used.

## AI usage

This project was built with Claude Code (Claude Sonnet 5.5) working in small steps (multi-material support was a second iteration, again tests first, with a migration check on both a fresh and an existing seeded database): inspect, plan, write the pytest tests for the core rules first and see them fail, implement the services until they passed, then build the UI and the Playwright tests. Test results were checked by running them after each stage. All code, rules and tests should still be reviewed by a developer before any real use.
