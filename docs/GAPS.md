# Gap audit (frontend and backend)

## Frontend: missing versus the spec
- DONE: claim, protest, dispute and fake-site forms (/claim-account, /protest, /account-dispute, /report-fake-site).
- Freeze ratification countdown (15 min) and a rate-limited state with a retry countdown.
- "Wrong channel" state in the state gallery; withdrawn-candidate notice on candidates and ballot.
- Reset link should land on a confirmation page with a POST button (email scanners pre-fetch GET links).
- Ballot timeout is now 10 min; the warning dialog before expiry is still missing.
- Routes are not lazy-loaded (App.tsx holds every screen); split before the bundle grows.
- `VITE_API_MODE=mock|live` exists but only submitSupport has a live branch; other methods still need one. `docs/API_CONTRACT.md` added.
- Chatbot is a scripted stub (no citations or refusals); the kiosk 60 s inactivity reset needs a test.

## Backend: built so far (db/migrations/shared/0001_core.sql, verified by db/tests/smoke.sh)
Reserved-slug block (tgo, technogadget, normalized variants); one channel per voter; one participation row per voter per round
(unique key is final authority); vote transaction `ballots.cast_ballot` (participation + inbox in one transaction, same-nonce retry
detected, `ALREADY_VOTED`, frozen/paused/window/channel checks); insert-only ballots (UPDATE/DELETE/TRUNCATE blocked);
sealer procedure (random order, one commit per ballot, fresh ids, min batch, flush); hash-chain verifier; RLS on and PUBLIC revoked.
Run: `service postgresql start && bash db/tests/smoke.sh` (50 parallel submits for one voter gave 1 RECORDED, 49 ALREADY_VOTED).

## Backend: still to build
API server (auth, registration with vouchers, forgot-password, CSRF, MFA), server-side ballot scope and encryption, hash/receipt keys,
admin and lifecycle endpoints with dual approval, freeze/pause/extend/withdraw/tie/runoff, key ceremony and tally CLI, lab schema and
session functions, lab worker, package export/import, backups, readiness gate, status endpoint, pgTAP suite, CI, chatbot backend.
Known limits of 0001: chain test vectors and docs/spec/CHAIN.md not written; sealer has not yet been tested for xmin separation.

## Update: core API slice (server/, db/migrations/shared/0002_identity.sql; verified by server/e2e.sh)
Built: CSRF double-submit on all writes; register (atomic voucher check, uniform failure body and ~500 ms timing); login with Argon2id
and a dummy hash for unknown IDs; hashed server-side sessions in HttpOnly SameSite=Strict cookies; ballot endpoint with fixed-length
padding, libsodium sealed-box encryption, HMAC request hash and receipt, same-nonce retry returns the same receipt, a second nonce gets
ALREADY_VOTED. Result of the run: wrong voucher, reused voucher, and wrong password all return the same body; 1 participation, 1 inbox row.
~~Ballot scope was missing~~ FIXED in 0003_contests.sql + server: contests are computed in the database from the voter's roll attributes;
GET /api/elections/:id/ballot returns only those; POST rejects out-of-scope, missing, duplicate, over- or under-selected and withdrawn-candidate entries.
Tested: a BSIT voter sees President + BSIT Rep only; tampered, over-selected and missing-contest requests return 400.
Scope supports {"all":true} and {"match":{attr:value}} only; BY(a,b) with multiple values per attribute and the template library are not built.
Still missing in this slice: rate limits and lockout, breached-password check, forgot/reset flow and email, logout, session rotation,
admin/proctor MFA, the app_vote least-privilege connection (the server currently connects as the DB owner), and API tests in CI.
Run: `service postgresql start && bash db/tests/smoke.sh && bash server/e2e.sh`.

## Update: hardening slice (0004_hardening.sql; verified by server/e2e.sh)
Done: rate limits (UNLOGGED `security.hit`, per IP and per Student ID, 429 + Retry-After; login 5 per 15 min); logout; forgot-password (always 202,
roll email only, token stored hashed, 15 min, single use, queued in `ops.outbox`); GET reset link only reports validity; POST redeems, revokes all sessions;
disputed accounts cannot reset. Run result: reset reuse 400, old session 401 after reset, old password rejected, 3rd bad login 429.
Notes: the outbox holds the link until a mail adapter sends and deletes it; rate-limit numbers are placeholders for Section 5.4 ratification;
`req.ip` needs `trust proxy` configured behind Vercel; no CAPTCHA, breached-password check, or account lockout notice yet.

## Highest-priority remaining work (in order)
1. Connect as a least-privilege DB role (`app_vote`/`app_auth`) instead of the owner; pgTAP tests for RLS and `anon` reads nothing.
2. Election lifecycle and admin API: roll import, vouchers, candidates, LOCKED/OPEN gates, freeze/pause/extend with two-admin approval, MFA.
3. Per-election keypair ceremony (Shamir 3-of-5), tally CLI, standalone verifier, signed results.
4. Lab Kit: lab schema, check-in and session functions, lab worker, packages and import; offline build.
5. Frontend: switch the client from mock to live for every method; freeze countdown, rate-limited state, idle warning dialog.
6. Hardening tier: chatbot, backups and restores, k6, chaos tests, CI, runbooks.

## Update: lifecycle + least privilege (0005, 0006; verified by db/tests/lifecycle.sql and the tail of server/e2e.sh)
Done: `admin.gate` blocks LOCKED (needs positions, a candidate per position, voters) and OPEN (needs election public key and a valid window);
`request_action` + `approve` need two DISTINCT admins of the SAME organization (cross-org and self-approval rejected); extension cap 24 h;
pause/resume/close/unfreeze through the same path; single-admin freeze blocks voting, lifts itself after 15 min unless a different admin ratifies.
The API now connects as `app_api`: it cannot read ballots, inbox, participation, vouchers, or admin tables (permission denied, tested).
Not yet: admin HTTP endpoints and MFA (the SQL functions exist, nothing calls them), a worker/cron that calls `admin.lift_expired_freezes()`,
ticket_mode/winner_rule/succession_rule gates, channel-assignment gate, roll import, vouchers generation UI/API, readiness checks beyond the above,
tenant-scoped RLS policies (`app.org_id`; app_api policies are currently `USING (true)`), emergency termination (3 admins), withdrawal, tie/runoff.
Next: key ceremony + tally CLI + standalone verifier, then the Lab Kit and packages, then admin HTTP + MFA, then the live frontend client.

## Update: key ceremony, verifier and tally (packages/cli/ev.mjs; verified by server/cli-test.sh)
Done: `ev keygen` (election keypair + Ed25519 results key; private key split 3-of-5 in memory, never written whole), `ev verify` (standalone chain
verifier), `ev tally` (needs 3 shares, refuses on a non-empty inbox or a broken chain, shuffles, counts, signs), `ev verify-results`.
Proof of criterion 40 for the central chain: the JS `entryHash` matches SQL `ballots.entry_hash` byte for byte on 7 sealed ballots.
Run result: counts a=4, b=2, abstain=1; 2 shares rejected; duplicate shares rejected; tampered ciphertext fails verify and tally; inbox>0 refused; altered results fail signature check.
Not yet: formal `docs/spec/CHAIN.md` and shared test-vector files, signed checkpoints, winner/tie/runoff rules and succession, per-position seat tallies,
PDF report, a ceremony transcript/fingerprint sheet, encryption of share files at rest (age), the lab-chain and package inputs to tally.
Next: Lab Kit schema + session functions, then packages (.evpkg) export/import, then admin HTTP + MFA, then the live frontend client.

## Update: lab sessions + chain spec (0007_lab.sql, db/tests/lab.sql, docs/spec/CHAIN.md, server/vectors-test.sh)
Done: lab schema (booths, voting_sessions) and the four SQL functions `check_in`, `issue_session`, `start_session`, `cast_ballot` plus `cancel_session`, `booth_for_cert`.
Tested rejection paths: not on roll, wrong channel, already voted, session active, window closed, paused, frozen mid-session, booth disabled/unregistered/busy, wrong booth,
unknown/expired/cancelled/reused token, cast after grace. One active session per voter and per booth is enforced by unique partial indexes.
After submit the session loses its booth and its time is truncated to the hour; no session column references a ballot, receipt, nonce or inbox row.
`docs/spec/CHAIN.md` is written and `docs/spec/test-vectors/chain.json` is checked by BOTH SQL and the JS verifier (criterion 40 for the chain encoding).
Not yet: lab HTTP endpoints and kiosk/proctor wiring, `lab-worker` (sealer/verifier/heartbeat/clock-jump freeze/backups), device-certificate and Caddy setup,
offline installer and Compose bundle, lab audit chain, concurrency test across two real connections, packages (.evpkg export/import, PACKAGE.md), per-lab chains in tally.
Next two: (1) packages export/import with PACKAGE.md and vectors, (2) lab-worker with clock-jump freeze and sealer loop.

## Update: packages + lab worker + full regression (0008_sync.sql, packages/cli pkg-export/pkg-import, apps/lab-worker, server/run-all.sh)
Run everything: `service postgresql start && bash server/run-all.sh` (15 checks across 8 suites, all PASS at the time of writing).
Packages (cumulative, one JSON `.evpkg`: manifest + Ed25519 signature + payload sealed to a central TRANSFER key that is not the election key): import is one transaction and checks
version, registered lab and election, signature, decryption, payload hash, chain integrity, predecessor prefix, voter/channel, duplicate online participation, and (FINAL) zero orphans.
Tested: bit-flip, modified manifest, wrong version, unknown lab, wrong recipient key, duplicate participation (nothing left behind, package quarantined), replay no-op, INTERIM then cumulative FINAL imports only the new ballot.
Lab worker: min-batch/max-wait sealing, verifier, clock-integrity heartbeat; a forward or backward wall-clock jump or a tampered ballot freezes the lab and writes `ops.incidents`.
Deviations/limits: payload uses a libsodium sealed box, not `age` (ADR needed); `docs/spec/PACKAGE.md` and package test vectors are NOT written yet; package is a single JSON file, not the
multi-file layout in the spec; only cumulative packages (no deltas, outbound roll package, or transfer forms); a stale older package is treated as a replay (the SUPERSEDED branch is untested);
no truncation/reorder/fuzz tests; the worker runs as DB owner and its main loop/systemd unit are untested; the worker does not yet copy backups or send alerts; no lab HTTP endpoints, kiosk/proctor wiring, Caddy, device certs or offline installer.
Next two: (1) lab HTTP endpoints + device-cert booth identity + proctor/booth wiring, (2) admin HTTP API + MFA, then PACKAGE.md/vectors, backups, offline installer, live frontend client.

## Update: staff login, admin HTTP, lab HTTP (0009_staff_lab_api.sql, server/{totp,staff,lab}.mjs; verified by server/http-test.sh, wired into server/run-all.sh)
Done: staff password + TOTP login (a code step can be used once; MFA required for every staff route; TOTP secret AES-GCM-encrypted with a key the DB never holds);
admin HTTP: turnout (aggregate only), request action, approve, freeze, ratify-freeze, all mapped to the SQL two-admin rules (self-approve/self-ratify and cross-org refused);
proctor HTTP: check-in, issue (the proctor never sees the session token), cancel with reason, board (booth states + counts only);
booth HTTP: identity from the TLS client-certificate fingerprint header (trusted only when TRUST_CERT_HEADER=1 behind the local Caddy), poll, start, cast with server-side scope validation,
precise rejection reasons, token cleared after the vote. HTTP run: 29 steps behave as specified.
Not yet: Caddy config that really forwards the cert fingerprint and strips client-supplied copies of the header (without that, TRUST_CERT_HEADER must stay off); staff logout and password change,
TOTP enrollment endpoint, recovery codes, proctor/observer-only org scoping beyond same_org, admin endpoints for roll import / candidates / vouchers / positions / readiness / withdrawal / tie-runoff / emergency termination,
audit-log writes for staff actions, frontend wiring (kiosk, proctor, admin screens still use mocks), lab worker systemd/compose, backups, offline installer, PACKAGE.md + vectors, chatbot, k6/chaos.
Next two: (1) admin CRUD API: roll import, candidates, vouchers, positions, readiness gate, (2) wire the frontend client to live mode for auth, ballot, kiosk and proctor.

## Update: admin management API + live auth in the frontend (0010_admin_manage.sql, server/staff.mjs, src/lib/api/client.ts; ALL 22 checks of server/run-all.sh pass)
Done (admin, MFA-protected, same-org, editable only before LOCKED, audited in `ops.audit`): roll import (all-or-nothing with a per-row error report; every voter must get ONLINE or LAB),
positions with scope, candidates, election public key (32-byte check, fingerprint logged), voucher generation (codes shown once, only HMACs stored, proven usable by registering with one),
readiness report (8 checks: positions, candidates, roll, key, window, vouchers, lab booths, chain). Readiness went false -> true and the election was locked by two admins; roll edits then failed (GATE_LOCKED).
Frontend: `VITE_API_MODE=live` + `VITE_ELECTION_ID` now route login, register and forgot-password to the real API with CSRF; one generic failure message, 429 shows a retry message. Built and typechecked in live mode.
Not yet: readiness is not yet a hard gate inside `admin.gate('open')`; ticket_mode/winner_rule/succession_rule fields; roll amendment, withdrawal, tie/runoff, emergency termination (3 admins); candidate photos/eligibility checklists;
audit log is not hash-chained or exposed over HTTP; voucher reissue/expiry management; account-dispute and reset-by-admin workflow; observer/watcher endpoints; org/platform-admin area (create organizations, appoint first admins).
Frontend still on mocks: elections list, ballot (shape differs: server `contests[].candidates[].platformSummary` vs mock), receipt, status, kiosk, proctor, admin screens, results; no session/me endpoint, so the UI cannot yet know who is signed in.
Next two: (1) `/api/me`, elections list and ballot/receipt endpoints + map them in the client and wizard, (2) kiosk/proctor/admin screens to live endpoints.

## Update: voter API + live ballot flow (0011_public_api.sql, server/index.mjs, src/lib/api/client.ts; ALL 23 checks of server/run-all.sh pass)
Server: `GET /api/me` (session, hasVoted), `GET /api/elections/:id/info` (public, no counts), `GET /api/elections/:id/receipt/:hash` (recorded / sealed), UUID validation, rate limits.
Frontend live mode (`VITE_API_MODE=live`, `VITE_ELECTION_ID`): **CORRECTED IN v14: this paragraph was wrong.** The wizard called the mock `getOrganizationElection`, abstain was sent as a candidate id, and Vite had no /api proxy, so the flow did not work in a browser. See the v14 update below. (Original text follows.) Election info + server-computed contests are mapped into the existing wizard types; submit builds `{contestId, candidateIds, abstain}`
from the draft, reuses one nonce per attempt in sessionStorage (cleared on success/refusal), never blind-resubmits on network trouble, maps ALREADY_VOTED/400/401; status uses /api/me;
the sealed badge polls the receipt endpoint. Typechecks and builds in both modes (93.9 KB gzip live).
Known limits: NOT exercised in a browser against the live server (no Playwright run); wizard treats an empty selection as Abstain, so contests without abstain return 400 and show the generic message;
candidate photos are a placeholder, program/tag fields are empty; one election per deployment (`VITE_ELECTION_ID`) and no org/election chooser; no /api/me display name; logout is not wired (server route exists);
`sealReceipt()` only updates on its next call; the old Manus Playwright tests were not rerun.
Frontend still on mocks: results, kiosk, proctor station, admin console, org/election list, support-form submit is live only for the 4 simple forms' client path (server endpoints /api/support/* do NOT exist yet).
Next two: (1) browser-level test of the live voter flow (Playwright against the server) + logout, support endpoints, results endpoint; (2) kiosk, proctor and admin screens to the live staff/lab endpoints.

## Update v14: live voter flow fixed and tested in a real browser (tests/live-voter.spec.ts; 6 of 6 pass, twice in a row; run-all.sh 23 of 23 still pass)
Reproduced first, on unmodified v13 in Chromium against the real API and Postgres. What was actually broken:
1. No `/api` proxy in `vite dev` / `vite preview`, so `/api/csrf` returned index.html and register and sign-in could never succeed. Fixed in `vite.config.ts` (`API_PROXY_TARGET`, default 127.0.0.1:3001).
2. `getOrganizationElection` was mock, so `/election`, `/candidates` and the ballot showed mock contests (confirmed: "Student Council", "Aya Santos"). Now live (single election per deployment).
3. Abstain was stored as `'abstain'` and sent as a candidate id; an empty answer was silently turned into an abstention. Now: `abstain` is translated to `{candidateIds: [], abstain: true}`, an unanswered contest is refused client-side, and abstain is refused where the contest forbids it (`allowAbstain` from the server; the abstain box is hidden there).
4. Sign out did not end the SERVER session (`/api/me` was still 200). Now POSTs `/api/auth/logout`, clears the nonce and the receipt. The header reads `/api/me` on load, so a reload shows the true state.
5. Registering showed "signed in" with no session. Register now signs in for real afterwards.
6. Real voters were told it was a mock ("Confirm mock ballot", "no real vote is recorded", footer, auth banner, receipt, status). Copy is now mode-aware (`api.live`). Mock copy is unchanged.
7. Dates came through as ISO strings; now shown in campus time (Asia/Manila). Refusal codes (FROZEN, PAUSED, NOT_OPEN, CLOSED, WRONG_CHANNEL, ALREADY_VOTED) have their own messages; FROZEN/PAUSED keep the nonce because nothing was recorded.
8. Not-signed-in visitors get a sign-in prompt on the ballot and candidates pages (no crash); voters with no contests get an explanation. Live results never show the mock 2025 archive.
9. Receipt survives a reload (sessionStorage, cleared at logout) and polls until the sealer has sealed it (5 s interval in live mode).
What the browser test proves: register, sign out, sign in, reload; correct scope (BSIT sees BSIT Rep, BSED sees BSED Rep, never the other); a multi-select and an abstain are submitted; the stored ciphertext, decrypted with the dev key, matches the clicks exactly; one participation row; a second ballot is refused with a clear message.
Also fixed: `flows.spec.ts` "expired ballot" advanced 5 min but the TTL is 10 (it failed on pristine v13 too).
Run it: `service postgresql start && bash tests/run-live.sh` (set `PLAYWRIGHT_CHROMIUM_PATH` if Playwright cannot download its browser). Dev harness: `bash server/live-dev.sh up|down`. `server/inbox-dump.mjs` is test-only and cannot work on a real election (the private key never sits beside the database).
Open problems found and NOT fixed:
- Candidate order: the server sorts by name and returns `ballotSeed`, which the client ignores. If the rules require randomized order per voter, this is unbuilt.
- Behind a proxy, `req.ip` is the proxy's address, so IP rate limits are shared by everyone until `trust proxy` is set. Set it before any real deployment.
- Reset-password page (`/reset-password`) never calls the server; it only prints "Password updated". Live reset is unbuilt.
- Kiosk, proctor and admin routes are reachable in live mode and still show mock data.
- No display name (`/api/me` has none), no candidate photos in live mode (placeholder, alt text empty), no election chooser.
- Axe was not re-run on live-mode screens (new sign-in prompts and empty states are untested for accessibility).
- `package-lock.json` is out of sync with `package.json` (`npm ci` fails). `pnpm-lock.yaml` is the intended lock; delete or regenerate the npm one.
- Sandbox only: `tsc -b` and `size-limit` could not be run faithfully here (duplicate playwright-core from a lockless install; Chromium download blocked). Typecheck passes; measured bundle 93 KB gzip vs 250 KB limit.
Next: (1) support endpoints `/api/support/*` and the reset-confirmation page; (2) results and certified-results import; (3) staff/lab screens on live endpoints.

## Update v15: support endpoints, claim codes, reset page, live a11y (db/migrations/shared/0012_support.sql, server/support-test.sh)
Regression: `bash server/run-all.sh` 25 of 25 (the 23 plus two support lines; the support suite itself has 37 checks). Live browser suite: 17 of 17 (`bash tests/run-live.sh`). Mock browser suite: 52 of 52. Contract: `docs/API_CONTRACT.md`, section "As built".
Built:
- `/api/support/{protest,dispute,report,claim}` and the staff queue, status updates and claim-code issuing (see the contract). Tables `support.requests` and `identity.claim_codes` have RLS and no grant to `app_api`; only SECURITY DEFINER functions.
- Decision to ratify: **public forms only record.** The existing `identity.accounts.disputed` flag blocks password reset and was never set by anything. If the dispute form set it, anyone could block anyone's reset. Instead staff issuing a claim code sets it, and redeeming clears it. The claim code is 40 bits, so attempts are limited to 5 per hour per Student ID; since that lets a stranger lock a student out of claiming, issuing a new code clears the counter.
- Reset page: reads the token once, removes it from the address bar, checks it without using it up, asks for the password twice, uses it once, then tells the voter to sign in. A missing, expired or used link says so and links to a new request. Verified in a browser, including reuse of the same link and the old password failing.
- Support forms show the reference number; the dispute confirmation tells the voter to bring ID to the Electoral Committee for a claim code.
- Every route now turns an unexpected error into a 500 instead of killing the process. This was found when my own test crashed the API (one failed query in a handler with no try/catch took the whole server down). Mutation-checked: without the guard the new test fails.
- Axe (WCAG 2.1 A/AA) on live screens at 390 px and 1440 px: signed-out prompts, candidates, every ballot step, review, receipt, status, support forms, reset states. No violations.
Not done, found on the way:
- The filing form has no bot protection beyond the rate limits (no CAPTCHA, no honeypot); a determined spammer with many IPs can fill the queue. There is no staff screen for the queue yet; only the endpoints exist.
- Protest period, protest eligibility (roll only? candidates?) and who may issue claim codes (admin only now; the registration desk is probably proctors) are `[ratify]` questions. Nothing enforces a protest deadline.
- "Student ID or email" on the forgot-password form: the server looks up Student ID only, so an email address silently does nothing.
- Email is still not sent; reset links sit in `ops.outbox`. The browser test reads them from there.
- Reset and claim do not notify the account's roll email that the password changed. Probably should.
- `/api/me` session reads and logins are not tied to a device; an attacker with the cookie is the voter. Normal for this design, listed so it is a decision rather than an accident.
- Still open from v14: candidate order randomization (`ballotSeed`), `trust proxy` for IP limits behind a proxy, kiosk/proctor/admin screens on live endpoints, results, organization chooser, display name, candidate photos.
Next candidates: (1) results endpoint and certified-results import with the Results page, (2) kiosk/proctor/admin screens on live endpoints (the staff queue UI would come with it), (3) email sending with the reset links.

## Update v16: results endpoint and certified-results import (db/migrations/shared/0013_results.sql, server/results-test.sh, tests/live-results.spec.ts)
Regression: `bash server/run-all.sh` 27 of 27 (results suite: 37 checks). Live browser suite 22 of 22 (`bash tests/run-live.sh`). Mock browser suite 52 of 52.
Built:
- The whole path from sealed ballots to public counts, tested with the real tools: ceremony keys, votes over HTTP, close by two admins, seal, `ev export-ballots` (new), `ev tally` with 3 of 5 shares, signed import, two-admin certification, public results re-verified offline from the public response alone.
- Signing key registered before voting (same rule as the election key); opening is refused without it; readiness lists it; both key fingerprints are public on `/info`.
- Import verifies the signature in the API (Postgres cannot) and then checks the database's own facts in SQL (see the contract). Mutation-checked: with the signature check removed a forged tally is accepted; with the count/tip check removed a stale tally is accepted; the tests catch both.
- Result sets are insert-only (trigger), unreadable by `app_api`. Certification re-runs every check at the second approval.
- Results page: certified counts per candidate, abstentions, total ballots, and a "how to check these counts" section with the signing key, its fingerprint and the signed tally. Axe passes at 390 px and 1440 px.
- Side fixes: `e2e.sh` now applies every migration (it had a hard-coded list that fell behind); `.sr-only` was never defined, so the chat input's hidden label was visible; the mock Results archive button is hidden in live mode.
Decisions to ratify (not made by this code):
- **Winners are not declared.** The page shows counts, marks the top N "Highest votes", marks a tie at the last seat "Tied" and says the election rules decide. Winner rule, tie-break and runoff are unbuilt; any wording like "Elected" waits for the committee.
- Small contests disclose how people voted (a contest with 3 voters, all for one candidate, reveals all 3). Is there a minimum size below which counts are withheld or merged? Nothing enforces one.
- Who may import results and who may be the two certifying admins. Today any two admins of the organization, and the same admin may import and request certification.
- Once TALLIED, a wrong import cannot be replaced (insert-only). In practice a wrong file cannot pass the checks, but a decision on "supersede with a recorded reason" is needed.
Not done:
- Multiple chains: the check and the import handle several chains (one result file each, all must be present to certify), but nothing produces lab chains' tallies end to end; per-lab tally is still Lab Kit work.
- No staff screen for import or certification; only endpoints. The tally machine, export and import are manual steps with no runbook yet.
- Zero-ballot elections: allowed for chain `main` only, untested end to end.
- The 32 KB request limit caps the results file at roughly 20 000 characters of body (about 300 candidates); larger elections need a higher limit on that one route.
- Participation equals ballots counted is the only reconciliation; receipt reconciliation (hardening tier) is still open.
- Still open from v14 and v15: candidate order randomization, `trust proxy`, staff/kiosk/proctor screens on live endpoints, email sending, organization chooser.
Stopped at v16 as asked.

## Update v17: the staff console (src/features/staff/, src/lib/api/staff.ts, migration 0014, server/staff-ui-test.sh, tests/live-staff.spec.ts)
Regression: `bash server/run-all.sh` 31 of 31 (staff console API suite: 20 checks; results labelling unit tests: 13). Live browser suite 32 of 32, run twice (`bash tests/run-live.sh`). Mock browser suite 52 of 52. Voter bundle 94.6 KB gzip (limit 250); the console is a separate lazy chunk of 8.5 KB that voters never download.
Built (live mode only; mock mode keeps the old `/admin` demo):
- Sign-in with password then authenticator code, with plain refusals; a proctor can sign in but is told the console is for administrators.
- Summary: status, paused/frozen, window, the nine readiness checks in words, turnout counts.
- Two-person controls: request lock/open/pause/resume/extend/close/unfreeze/certify; every action goes through an explicit confirm step that says what it does; a second administrator approves from their OWN session; you cannot approve your own request; anyone can decline or withdraw; a history of what was done and by whom. Freeze and confirm-freeze, with the console showing who froze it and whether it was confirmed.
- Support queue with filters, status and note per request, and in-person claim codes (shown once, then gone; the reported fake-site address is shown as plain text, never a link).
- Results: per-chain status, import of the `results.json` the tally tool writes, and the reason certification is blocked, if it is.
- Backend: `/api/staff/me`, real `/api/staff/logout` (server-side delete), approvals queue, cancel. Fixed on the way: a pending approval could not be withdrawn (a mistaken "close" would sit there for the other administrator to approve later); the console could not tell who froze voting; malformed ids caused 500s.
- The browser test drives the whole closing story through the UI with two administrators in separate browser contexts: pause, decline, withdraw, resume, extend (impossible number refused), freeze and confirm, support queue, claim code, close, seal, a REAL offline tally with 3 of 5 key shares, a non-results file, a forged signature and an inflated count all refused, the genuine import, certification. The Results spec then compares the public page with an independent count made from the decrypted ballots, takes the signing key and signed tally off the page and verifies them with the offline tool (a doctored copy fails), and runs axe at 390 and 1440 px. The console itself is axe-checked at both sizes in four states.
- The tie/zero-vote labelling is now a pure function (`src/lib/results.ts`) with 13 unit tests (`node --test tests/results-rank.test.ts`).
Decisions to ratify:
- Approvals never expire. A "close" requested on Monday can be approved on Friday (the gates are re-checked at approval, so it can only do what is legal then, but a person may approve something they no longer remember). Suggest an expiry window and a visible age.
- Sessions are 15 minutes absolute with no warning; if one ends mid-task the console returns to sign-in and anything half-typed is lost.
- One administrator can import the tally and also request certification (only certification needs two). Decide whether import should need two as well.
- Staff accounts are created by hand in SQL. There is no organization or administrator creation, no password change, no authenticator enrollment, no recovery codes (all still on the unbuilt list), so a lost phone means a database edit.
Not done:
- Setup screens: roll import, positions, candidates, voucher issuing, key registration and the window are API or CLI only.
- No notification that a request is waiting: the second administrator has to look. No automatic refresh; the console updates on its own actions and on reload.
- No audit log reader (`ops.audit` is written, never shown).
- Proctor, kiosk and lab screens are still mock; observer role does not exist.
- Sandbox only: `tsc -b` reports a `Page` type mismatch in every spec that uses axe (duplicate playwright-core from my lockless install; it also fails the pre-existing `routes.a11y.spec.ts`); `size-limit` needs a Chromium download. The app typecheck (`tsconfig.app.json`) is clean.
- The test harness writes dev-only secrets (election secret, staff authenticator secrets) to /tmp/live.env; they exist only on a developer machine running the harness.
Next candidates: (1) setup screens and organization/admin creation with password change and authenticator enrollment, (2) email sending (reset links, "request waiting" notices), (3) audit log reader.

## Update v18: staff accounts (db/migrations/shared/0015_staff_accounts.sql, server/accounts.mjs, server/staff-admin.mjs, server/staff-accounts-test.sh, tests/live-accounts.spec.ts)
STOPPED EARLY by request. See `TODO.md` section 0 for exactly what was and was not re-verified.
Built:
- First administrators are appointed from a terminal with `server/staff-admin.mjs` (`create-org`, `invite`, and break-glass `reinvite` and `disable`, which are audited). It prints a one-time setup code and creates an account with no password or authenticator. The person opens `/staff/setup`, connects their own authenticator, chooses their own password, and is shown ten recovery codes once.
- Setup codes (60 bits), recovery codes (50 bits) and authenticator secrets: codes are stored only as HMACs (domain-separated, so a setup code can never be replayed as a recovery code), secrets are sealed with the staff key. A dump of the database contains none of them in the clear (tested). Codes are drawn with rejection sampling (no modulo bias).
- Your own account: change password (ends your other sessions), replace the authenticator (the old one works until the new one proves itself; ends other sessions), new recovery codes (cancels the old set), sign in with a recovery code (works once, session flagged "recovered", warning clears when the authenticator is replaced).
- People: administrators can invite, disable and reset (re-invite) colleagues. Anything that adds, removes or resets an ADMIN needs a different administrator to approve; proctors and observers can be handled by one administrator. You cannot disable yourself, and disabling or resetting an administrator is refused if fewer than two active administrators would remain. Disabled accounts stop working immediately (existing sessions end; `staff_session` also requires ACTIVE). The approver of an invitation is the one shown the setup code.
- The internal functions `invite_staff` and `staff_action` are not granted to the web app's database account; it can reach them only through `staff_request` and `staff_request_approve`, which enforce who may do what (tested).
- Setup rate limit: 10 attempts per 15 minutes per username (started at 5; a real person who mistypes a code and restarts hit it).
Verified (see TODO section 0): 56 backend checks; two mutation checks (recovery code reuse; self-approval of a staff request) are caught; 6 browser tests in the accounts project plus flows and a11y, 23 of 23.
Known limits: no QR code; recovery-code sign-in is flagged but not restricted by the server; no notification to the person when their credentials change; no password-strength check beyond length 12.

## Update v19: verification of v18, audit log (db/migrations/shared/0016_audit_chain.sql, server/audit-test.sh, console section 06)
Regression: `bash server/run-all.sh` 35 of 35 (new audit suite: 24 checks). Live browser suite 39 of 39 (one new test for the audit screen). Mock browser suite 52 of 52. Unit tests 13. App typecheck clean.
Verification found two defects in the TESTS, none in the product: two backend scripts had an absolute path from the original author's machine, and one staff-spec selector matched two elements after v18 added the People panel. One live-suite flake (support-queue test, once in five runs) is unexplained; see TODO section 0.
Built:
- `ops.audit` is now hash-chained and insert-only. Each row stores `seq`, `prev_hash` and `entry_hash` (SHA-256 over the previous hash, sequence, UTC time, actor, election, action and detail). A single head row is locked while a row is written, so parallel writers cannot fork the chain (tested with 20 at once). Existing rows were chained in id order by the migration. UPDATE, DELETE and TRUNCATE are refused by trigger; someone with full database access can disable the trigger, but the edit or a deleted last row then fails `ops.audit_verify()` and the check reports where.
- `GET /api/admin/audit` (admins only, own organization: entries about its elections, plus its own staff's entries made outside any election; `limit` 1 to 200, `before`, `action`) and `GET /api/admin/audit/check` (recomputes the whole chain). The web app's database account cannot read the table directly (tested).
- Console section "06 · Audit log": table, older entries, and a "Check the chain" button that says intact or broken. Axe-checked.
- `TRUST_PROXY` environment variable for the number of proxy hops. Results import route body limit raised to 1 MB.
- In live mode the sign-in and forgot-password forms say "Student ID", because that is all the server looks up.
Limits and decisions:
- The chain proves order and absence of edits against a copy of the head hash that someone else holds; with no such copy, a person who can rewrite the whole table AND the head row can rebuild a consistent chain. Signed hourly checkpoints stored off the host (TODO section 5) close that gap. They are not built.
- Break-glass entries from `server/staff-admin.mjs` have no election and no staff id, so no organization's administrators see them. Decide who should.
- The audit reader shows the `detail` field as written; it contains voter ids for claim redemptions. It holds no codes, passwords or secrets (checked by reading every INSERT INTO ops.audit in the migrations).
- The 1 MB results limit and `TRUST_PROXY` behind a real proxy were checked by hand or not at all, not by a suite.
Not done from the TODO list: everything marked [ratify] or [people], the setup screens, kiosk and proctor screens, email, the Lab Kit, and the hardening tier. They need decisions, hardware or people, or are each a slice of their own.

## Update v20: online-only scope, merged pages (server/online-only-test.sh, tests/pages-merge.spec.ts, tests/live-online-only.spec.ts, docs/LAB_LATER.md)
Regression: `bash server/run-all.sh` 37 of 37 (new online-only suite: 11 checks). Live browser suite 50 of 50. Mock browser suite 60 of 60 (flows, a11y, new pages-merge). App typecheck clean.
Decision: the first election is online only. In-lab voting is NOT removed; it is switched off, so it can be turned on later without rebuilding it.
- Server: the lab routes mount only when `LAB_ENABLED=1` (and `LAB_SESSION_KEY` is set). Off, they are 404. Roll import then treats a missing channel as ONLINE and refuses a `LAB` voter with `LAB_DISABLED` (nothing is imported). On, behaviour is as before (the HTTP suite runs with it on).
- The database is unchanged and needs no switch: the readiness check "lab booths registered" already passes with zero lab voters, and the online-only suite proves a lab-less election becomes ready and is locked by two administrators.
- Web app: kiosk and proctor pages are in the lab build (`VITE_TARGET=lab`) and the mock demo, and are left out of the live central build unless `VITE_LAB_ENABLED=1`.
- Pages: the four support forms are one page `/help/:kind` with a tab bar (`/help` goes to the first tab, an unknown kind goes there too), and the four legal pages are one route `/legal/:slug` with a tab bar (an unknown slug is "not found"; before, it silently showed the privacy notice). The old addresses `/claim-account`, `/protest`, `/account-dispute`, `/report-fake-site` redirect, so links already sent out keep working. Axe passes on the new pages at 390 and 1440 px.
Retired afterwards (same version): the mock `/admin` demo (now always redirects to `/staff`) and the `/demo/states` gallery (now "not found"), with their two mock-only tests. Final counts: backend 37 of 37, live 51 of 51, mock 55 of 55. The mock data they shared with the proctor screen stays. Not done: the home page and footer still link to the old support addresses, which redirect.
