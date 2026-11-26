# CTU Danao Student Elections

Online student voting with private ballots, verifiable receipts, two-person staff approvals and a tamper-evident audit log.
There is no demo or mock mode: the web app always talks to the real API.

- **Web app** (`src/`): React 19, Vite, TypeScript, Tailwind. Voter pages plus the staff console at `/staff`.
- **API** (`server/`): Node, serves `/api` on port 3001. Uses PostgreSQL (migrations in `db/migrations`).
- **CLI** (`packages/cli`): offline steps such as sealing, export and tally.
- **Lab Kit** (`apps/lab-worker`): in-lab voting. Parked for a later phase, see `docs/LAB_LATER.md`.

## What you need

- Node 20+ and pnpm
- PostgreSQL (the dev script needs `psql`, `createdb` and `dropdb` on your PATH)
- Windows: use Git Bash. If you have more than one PostgreSQL install, set the port and password first.

## Run it locally

```bash
pnpm install                  # also run this after pulling or unzipping a new version
(cd server && npm install)

# Windows / Git Bash only: point at the PostgreSQL you installed
export PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres PGPASSWORD='your-password'
export PATH="/c/Program Files/PostgreSQL/18/bin:$PATH"

bash server/live-dev.sh up    # creates database "evlive", seeds a test election, starts the API on :3001
. /tmp/live.env               # sets ELECTION_ID (on Windows, run: cat /tmp/live.env)
VITE_ELECTION_ID=$ELECTION_ID pnpm dev   # web app on http://localhost:3000
```

Stop the API with `bash server/live-dev.sh down`.

**Test accounts** (development only, created by the script):

| Who | Sign in with |
| --- | --- |
| Voters `2026-00001` to `2026-00005` | Register at `/register` with voucher `DEMO-1` to `DEMO-5` (the number matches the last digit of the ID), then choose a password |
| Staff `a1`, `a2`, `a3` (admins), `p1` (proctor) | `/staff/login`, password `staff-pass-123`, plus an authenticator code (secrets are written to `/tmp/live.env`) |

Shortcut: `bash server/staff-code.sh a1` prints (and copies) the current authenticator code for a test staff account. After pulling a new version, run `bash server/live-dev.sh up` again so new migrations (0017) apply.

The script writes development secrets to `/tmp/live.env`. Never run it on a machine that matters.

## Setting up an election

1. Terminal (owner access to the database): `node server/staff-admin.mjs create-org ...`, `create-election --org <slug>`, then `invite ...` for at least two administrators (see the top of that file). Build the site with the printed `VITE_ELECTION_ID`.
2. Browser, `/staff` then **Setup**: voting times, positions and candidates (with photos and who-can-vote rules), the voter roll (a header line such as `studentId,email,program,year` makes extra columns available for who-can-vote rules), voucher codes, and the two public keys.
3. Then request **Lock the election** under Approvals and controls. A second administrator approves.

## Help assistant (optional)

A small "Help" chat button answers voter questions from `server/assistant-faq.md` only. It is off unless the API has a key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...      # before: bash server/live-dev.sh up   (or in your production environment)
```

- **Edit the answers** in `server/assistant-faq.md` (the Electoral Committee should review it). Format: `## [id] Title | /page`. Restart the API after editing.
- It refuses questions about who to vote for and how anyone voted before any AI call is made, never appears on the ballot page, has no access to ballots or accounts, and stores nothing.
- Optional settings: `ASSISTANT_MODEL` (default `claude-haiku-5-5`), `ASSISTANT_DAILY_CAP` (default 2000 questions a day for the whole site). Per visitor: 5 a minute, 20 an hour.
- Test without a key or network: `node --test server/assistant.test.mjs`.
- The Privacy page already mentions the assistant. Have your data privacy officer approve sending questions to the AI provider before switching it on.

## Useful commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server on port 3000 (proxies `/api` to `API_PROXY_TARGET`, default `http://127.0.0.1:3001`) |
| `pnpm typecheck` | Type checks the app and config |
| `pnpm build` | Type check and production build |
| `pnpm check` | Typecheck, build and bundle-size check |
| `psql -v ON_ERROR_STOP=1 -f db/tests/setup_screens.sql` | SQL test for the setup functions (also `staff_session.sql`, `setup_edit.sql`); rolls back |
| `bash server/run-all.sh` | Backend test suites (share one database, run one at a time) |
| `node --test tests/qr.test.ts` | Unit test for the QR encoder (also `tests/results-rank.test.ts`) |
| `pnpm test:live` | Real-browser tests against the live API (Playwright) |

## Settings that matter

- `VITE_ELECTION_ID` (build time): which election the site shows. One election per deployment for now.
- `API_PROXY_TARGET`: where the dev server sends `/api`.
- `TRUST_PROXY=<hops>` (server, 1 to 5): required behind a reverse proxy, otherwise rate limits see the wrong address. The proxy must overwrite `X-Forwarded-For`, not append to it.

## Where things are

| Path | Contents |
| --- | --- |
| `TODO.md` | Everything still to do, grouped, with decisions the committee must make marked **[ratify]** |
| `docs/FRONTEND_HANDOFF.md` | Route map and front-end behaviour |
| `docs/API_CONTRACT.md` | The API, including "As built" notes |
| `docs/GAPS.md` | What was built in each version and why |
| `docs/spec/` | Audit chain spec and test vectors |
| `src/styles/tokens.css` | The single stylesheet: colour tokens (light, dark, high contrast) and all components |
| `tests/` | Browser tests (`live-*.spec.ts`) and unit tests |

## Before a real election

See `TODO.md` sections 5 and 6: backups and restore drills, load test for your voter count, runbooks, a key ceremony, legal review of the Terms and Privacy pages, and the committee decisions on tie and runoff rules.

## Starting it (development)

1. Double-click `start.bat`, or in Git Bash run `pnpm start`. The first time it asks for your PostgreSQL password and remembers it in `.dev-db.json` (not committed).
2. Open http://localhost:3000. Press Ctrl+C in that window to stop everything.
3. Need the staff 6-digit code? In a second window: `pnpm code`.
4. Something wrong? `pnpm run doctor` checks Node, packages, PostgreSQL, ports and leftover files, and says how to fix each.
5. `pnpm stop` closes stray copies still holding ports 3000 or 3001.
