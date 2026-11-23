# TODO: everything left to do

Status as of v20. **Scope: online voting only.** In-lab voting is deferred to a later phase and is switched off (see `docs/LAB_LATER.md`); the items in section 4 and the kiosk/proctor items are parked, not forgotten. Items marked **[ratify]** need a committee decision before code. Items marked **[people]** are not code.
Companion files: `docs/GAPS.md` (what was built, version by version, with the decisions made), `docs/API_CONTRACT.md` ("As built" sections).

## 0. Verification (done at v19)
Run one at a time, in this order (they share a database and `test-results/`): `service postgresql start`; `bash server/run-all.sh` (37 checks, about 2 minutes); `PLAYWRIGHT_CHROMIUM_PATH=... bash tests/run-live.sh` (51 tests, about 5 minutes); then the mock suite (`vite preview --port 3000`, `npx playwright test tests/flows.spec.ts tests/routes.a11y.spec.ts tests/pages-merge.spec.ts`, 55 tests). All green at v20, plus the 13 unit tests and a clean app typecheck.
- Found and fixed while verifying v18: `server/cli-test.sh` and `server/worker-test.sh` had `/home/claude/ctuvote` hard-coded (now relative to the repo root); the staff spec's `getByText('Nothing is waiting.')` matched two places after v18 added the People panel (now scoped to the controls panel).
- One unexplained flake: in one of five live runs the staff spec's support-queue test timed out (30 s) and the next three runs passed. Cause not found. Suspect the TOTP step reuse (`a1`/`a2` within 30 s) or the accounts spec's `relax()` shortcut. If it recurs, run `npx playwright show-trace` on the failure.
- Setup note: `pnpm install --frozen-lockfile` needs `npm_config_manage_package_manager_versions=false` when the registry only serves the installed pnpm; `server`, `packages/cli` and `apps/lab-worker` each need their own `npm install`.

## 1. Frontend
Not built:
- [ ] (parked with the Lab Kit) Kiosk and proctor screens on live endpoints (the old mock screens were removed with the demo mode and need to be built fresh). Admin screens are done: `/staff`.
- [ ] Organization and election chooser (live mode assumes one election, `VITE_ELECTION_ID`; the id in the URL is ignored).
- [ ] Signed-in display name for voters (`/api/me` has none) and candidate photos in live mode (placeholder with empty alt text today).
- [ ] Freeze countdown, rate-limited state, ballot idle-warning dialog.
- [ ] Route lazy-loading for the voter routes (only the staff console is lazy), per-route axe re-run for any new voter screen, a Content-Security-Policy.
- [ ] The chatbot beyond a scripted stub (and its backend, section 4).
- [ ] Candidate order: the server returns `ballotSeed` and the client ignores it; candidates are alphabetical. Randomize per voter if the rules require it **[ratify]**.
- [x] Forgot-password and sign-in said "Student ID or email" but the server only looks up Student ID. Both now say "Student ID". Looking up by email is not built.
- [ ] Reset/claim success should tell the voter their roll email will be notified (once email exists).
Staff console gaps (it handles operate-and-oversee; setup is still API or CLI):
- [ ] Setup screens: roll import, positions, candidates, scope rules, voucher issuing, key registration (election key, signing key), opening and closing times.
- [x] Audit log reader (console section 06: newest first, paging, "Check the chain"). Not built: filter controls in the screen (the API has `action` and `before`), export.
- [ ] "A request is waiting for you" notification (email, plus a badge in the console), auto-refresh, and a warning before the 15-minute session ends (today it silently returns to sign-in and loses anything half-typed).
- [ ] QR code for authenticator setup (today: typed key plus an `otpauth://` link).
- [ ] Observer/watcher screens; proctor screens.
- [ ] A screen for tally import is done; a screen to run or guide the offline steps (seal, export, tally) is not: today they are CLI steps with no runbook.
- [ ] Support queue: bot protection on the public forms (rate limits only today), bulk actions.

## 2. Backend
- [ ] Organizations area: create organizations and appoint first admins over HTTP (the setup tool `server/staff-admin.mjs` does it from a terminal; there is no platform-operator role).
- [ ] Candidate photos and eligibility checklists; positions with multi-attribute scope rules and the template library.
- [ ] `ticket_mode`, `winner_rule`, `succession_rule` fields and their gates **[ratify]**; readiness as a hard gate on opening (today only keys and window are enforced; the other readiness checks are advisory).
- [ ] Roll amendment, channel moves, finishing the account-dispute and admin-reset workflow (claim codes and re-invite exist).
- [ ] Candidate withdrawal, tie and runoff, emergency termination (three admins) **[ratify]**.
- [ ] Winner and tie rules in the tally, and the PDF report. The results page deliberately declares no winners until the rules are ratified.
- [ ] Observer and watcher roles.
- [x] Audit log with hash chain (migration 0016: insert-only, chained in commit order, tail deletion detected) and `GET /api/admin/audit`, `/api/admin/audit/check`. Still open: signed or off-host checkpoints of the head hash (section 5), and platform-level entries with no election and no staff member (the break-glass tool's) are not shown to any organization.
- [ ] Per-organization row-level security (policies are open to the app account today; the newer tables use "no grant, functions only").
- [ ] Approvals never expire (a "close" requested Monday is approvable Friday; gates re-check at approval) **[ratify]**; same for staff requests.
- [ ] One admin can import the tally and also request certification; decide whether import needs two **[ratify]**. A wrong import cannot be superseded **[ratify]**.
- [ ] Small contests disclose how people voted (counts of a contest with 3 voters); minimum size or merging rule **[ratify]**.
- [ ] Protest period and eligibility, and who may issue claim codes (admin only today; the registration desk is probably proctors) **[ratify]**.
- [x] `trust proxy`: set `TRUST_PROXY=<number of proxy hops>` (1 to 5; anything else stops the server at startup). Tested by hand: with 1, the limiter keys on the `X-Forwarded-For` client address. **Still must be set in the real deployment**, and the proxy must overwrite, not append to, client-supplied `X-Forwarded-For`.
- [ ] Staff: password rules beyond length 12, lost-password path (today: re-invite), sliding or idle timeouts, a "two administrators exist" onboarding check, notifying the account holder when their password or authenticator changes.
- [ ] Recovery-code sign-in marks the session but does not force replacing the authenticator (the console shows a warning; the server does not restrict).
- [ ] Results: zero-ballot elections untested end to end; the results route now accepts 1 MB (was 32 KB, about 300 candidates), but a large file has not been tested; multi-chain (lab) tallies are checked and importable but nothing produces them end to end.
- [ ] Receipt reconciliation (participation equals ballots counted is the only reconciliation).
- [ ] Remaining handlers: most routes are now guarded against crashing on a database error, but a review of every route for correct status codes is still owed.

## 3. Email (a dependency of several items above)
- [ ] Email sending (reset links only sit in `ops.outbox`; browser tests read them from there), provider failover.
- [ ] Notices: pending staff request, password or authenticator changed, claim redeemed.

## 4. Lab Kit (PARKED: phase 2, in-lab voting; nothing here blocks an online election)
- [ ] Caddy setup that really forwards the booth certificate and strips fake copies (until then the certificate header must stay off).
- [ ] Offline installer and Docker Compose bundle; the lab worker as a running service.
- [ ] Lab audit chain, encrypted lab backups, restore onto a spare install.
- [ ] Two-connection concurrency test; booth crash and power-cut tests.
- [ ] Outbound roll package and delta packages, transfer forms, per-lab chains in the tally.
- [ ] Package spec document and test vectors; `age` encryption (libsodium is used today).

## 5. Hardening and operations
- [ ] Chatbot backend.
- [ ] Backups every 15 minutes with restore drills.
- [ ] Off-host status page, alerts, signed hourly checkpoints, the hourly verifier job.
- [ ] Load tests (6,000 voters), lab capacity test, chaos tests, security scans in CI.
- [ ] Runbooks (including the offline close, seal, export, tally, import, certify steps), key-ceremony guide, onboarding guide, retention procedure.
- [ ] The nine game-day drills and the findings report.
- [ ] CI that runs everything: backend suites, unit tests, live browser suite, in sequence (they share a database and `test-results/`).

## 6. Needs people, not code
- [ ] Committee decisions on every **[ratify]** item above and the rate-limit numbers (staff sign-in 5 per 15 min per username; setup 10 per 15 min per username; claim 5 per hour per Student ID; support 10 per hour per IP and 5 per day per Student ID).
- [ ] Legal review of Terms and Privacy by counsel and the data privacy officer.
- [ ] A real key ceremony with real holders; inspection of real lab hardware.
- [ ] Choose who holds owner access to the database for the tally machine and for the setup tool.

## 7. Housekeeping and environment notes
- [x] `package-lock.json` deleted (it was out of sync; `pnpm-lock.yaml` is the lock). The three sub-packages keep their own `package-lock.json`.
- [ ] (Not rechecked at v19: `pnpm run build` uses `tsc -b`; only the app and node typechecks were run.) `tsc -b` shows a `Page` type mismatch in every spec that uses axe; in my sandbox it came from a lockless install pulling two `playwright-core` versions. Confirm it is clean with `pnpm install` from the real lockfile. `size-limit` needs a Chromium download; the voter bundle measured 94.6 KB gzip against a 250 KB limit (v17), staff chunk 8.5 KB (will have grown in v18).
- [ ] The live test harness (`server/live-dev.sh`) writes dev-only secrets (election secret, staff authenticator secrets) to `/tmp/live.env`. Never run it anywhere that matters.
- [ ] Tests that shortcut: the staff-accounts and accounts specs clear the sign-in limiter and the TOTP replay counter between sign-ins; both protections are tested for real once, in the backend suite.

## Done so far (for orientation)
v14 live voter flow and logout; v15 support forms, claim codes, reset page, global crash guard; v16 results import, certification, public results; v17 staff console (controls, approvals, support queue, results import) and two-person withdraw; v18 staff accounts (setup with a one-time code, password and authenticator changes, recovery codes, invite/disable/re-invite under the two-person rule); v19 verification of v18, hash-chained audit log with reader, `TRUST_PROXY`. Test counts for each suite are in `docs/GAPS.md`.
