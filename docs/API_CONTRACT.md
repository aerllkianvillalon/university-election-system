# API contract (client methods in src/lib/api/client.ts call same-origin `/api`)
Conventions: JSON, HttpOnly cookies, `X-CSRF-Token` (from `GET /api/csrf`) on every write. Errors: `{error:{code,message,correlationId}}`.
Failures for register, login, forgot, claim, protest, dispute and report return one uniform body and timing (no account enumeration).

| Client method | Endpoint | Notes |
|---|---|---|
| getOrganizations / getOrganizationElection | GET /api/orgs, /api/orgs/{slug}/elections | public, no counts |
| getResults | GET /api/elections/{id}/results | 404 until certified |
| getStatus | GET /api/me/status | `{eligible, ballot}` only |
| submitBallot | POST /api/elections/{id}/ballot | `{nonce, round, selections}` → `{receipt}`; same nonce returns same receipt; `ALREADY_VOTED` otherwise |
| register / authenticate / requestPasswordReset | POST /api/auth/register, /login, /forgot | forgot always 202 |
| submitSupport | POST /api/support/{claim\|protest\|dispute\|report} | see "As built: support, claim and reset" below |
Server decides ballot scope; the client never sends program, section or shift.

## As built: support, claim and reset (v15). The table above is the design; several rows differ from what exists (the voter API is `/api/me`, `/api/elections/{id}/info`, `/api/elections/{id}/ballot`, `/api/elections/{id}/receipt/{hash}`)
All writes need the CSRF header. Every refusal below is final: no endpoint tells a caller whether a Student ID exists.
| Endpoint | Body | Answers |
|---|---|---|
| `POST /api/support/protest` | `{electionId, studentId, subject, details}` | 202 `{ok, reference:"ABCD-EF23"}`; 400 `VALIDATION_FAILED` (missing field, over 200/4000/2000 characters, unknown election); 429 |
| `POST /api/support/dispute` | `{electionId, studentId, details}` | same. **Records only; never flags or changes an account.** |
| `POST /api/support/report` | `{electionId, url, details?}` | same; no Student ID kept |
| `POST /api/support/claim` | `{electionId, studentId, claimCode, password>=8}` | 200 `{ok}`; every failure (wrong code, wrong student, expired, used, no code) is the same 400 `REQUEST_FAILED` after a fixed 500 ms; 5 attempts/hour per Student ID then 429 |
| `GET /api/auth/reset/{token}` | none | `{valid}`; never uses the token up (mail scanners pre-fetch links) |
| `POST /api/auth/reset` | `{token, newPassword>=8}` | 200, or 400 `RESET_LINK_EXPIRED`; ends every session of that voter |
Limits: 10 support submissions/hour per IP; 5/day per Student ID per kind. A signed-in filer typing their own Student ID is stored as `session_verified`; staff see this and `on_roll`, the filer sees neither.
Staff (admin role, same organization only; proctors and other organizations get 403):
| Endpoint | Notes |
|---|---|
| `GET /api/admin/elections/{id}/support?status=&kind=` | newest first, up to 200 |
| `POST /api/admin/support/{requestId}/status` | `{status: IN_REVIEW\|RESOLVED\|DISMISSED, note?}`; audited |
| `POST /api/admin/elections/{id}/claim-codes` | `{studentId}` → `{claimCode:"ABCDE-12345", validDays:3}`, **shown once**; only an HMAC is stored. ONLINE voters only. Marks the account disputed (blocks reset), clears that student's attempt counter, audited |
Redeeming a claim sets the password (creating the account if none), clears `disputed`, ends all sessions, cancels pending reset links, audited.
Robustness: any unexpected error in any route is a 500 `SERVER_ERROR` with no internals, and the process keeps serving (Express 4 would otherwise die on one rejected promise).

## As built: results and certification (v16)
| Endpoint | Notes |
|---|---|
| `GET /api/elections/{id}/results` | Public. Before certification: only `{published:false, status}`. After: per contest `{id,title,seats,abstain,candidates:[{id,name,votes}]}` (highest votes first, zero-vote candidates included), `ballots`, `certifiedAt`, `signingKey`, `signingKeyFingerprint`, and `sets:[{chain,ballots,chainTip,body,signature}]` so anyone can re-verify with `ev verify-results`. No voter data of any kind. Winners are not declared. |
| `GET /api/elections/{id}/info` | Now also `electionKeyFingerprint` and `signingKeyFingerprint` (first 16 hex of SHA-256) to compare with the key ceremony. |
| `POST /api/admin/elections/{id}/signing-key` | `{publicKey}` (32 bytes, base64). Only while DRAFT, CONFIGURED or LOCKED. Audited. Opening is refused without it (`GATE_NO_SIGNING_KEY`). |
| `POST /api/admin/elections/{id}/results` | `{results:{body,signature}}`, the file `ev tally` writes. One per chain, once. Checks, in order: signature against the registered key (`GATE_BAD_SIGNATURE`); election CLOSED or TALLIED; inbox empty (`GATE_UNSEALED_BALLOTS`); chain verifies (`GATE_CHAIN_BROKEN`); body's ballot count, chain tip and chain name equal the database's (`GATE_RESULTS_MISMATCH`); every contest and candidate id belongs to this election, no negative or non-numeric count, no candidate above `ballots - abstentions`, no contest above `seats x (ballots - abstentions)` (`GATE_RESULTS_INVALID`); not already imported (`GATE_ALREADY_IMPORTED`). Success sets status TALLIED. Body limit about 20 000 characters. |
| `GET /api/admin/elections/{id}/results` | Per chain: ballots, imported, matches; inbox and participation counts; `certifyBlocker` (null when certification can go ahead). |
| `POST /api/admin/elections/{id}/actions` `{action:"certify"}` | Two admins, like lock and open. Blocked unless TALLIED, inbox empty, every chain that holds ballots verifies and has a result set that matches its count and tip, and participation rows equal ballots counted (`GATE_UNSEALED_BALLOTS`, `GATE_RESULTS_MISSING`, `GATE_CHAIN_BROKEN`, `GATE_RESULTS_STALE`, `GATE_PARTICIPATION_MISMATCH`). Checked again when the second admin approves. |
Tally input: `ev export-ballots --db <url> --election <uuid> --out export.json [--chain main]`, run with owner access to the database on the tally machine, never on the web server.

## As built: staff console endpoints (v17)
All need a staff session (password then authenticator code, 15 minutes, absolute). Writes need the CSRF header.
| Endpoint | Notes |
|---|---|
| `GET /api/staff/me` | Admin or proctor. `{name, role, organization, elections:[{id,status,paused,frozen,opensAt,closesAt,certifiedAt,freezeByMe,freezeConfirmed}]}`. Only the caller's own organization. |
| `POST /api/staff/logout` | Deletes the session on the server (a copied cookie stops working) and clears the cookie. Harmless without a session; refused without the CSRF token. |
| `GET /api/admin/elections/{id}/approvals` | Admin, same organization. `{pending:[{id,action,params,createdAt,initiator,mine}], recent:[{action,params,initiator,approver,at}]}` (last 10 done). |
| `POST /api/admin/approvals/{id}/cancel` | Either administrator of the organization can withdraw (the requester) or decline (anyone else) a pending request. Audited (`REQUEST_CANCELLED`). A cancelled request can never be approved. An executed one cannot be cancelled. |
A malformed id in any `:id` position is a 404 (it used to reach the database and become a 500).
The console is `/staff/login` and `/staff` (lazy-loaded; `/admin` redirects to it).

## As built: staff accounts (v18)
Public (rate limited, every failure identical): `POST /api/staff/setup/start {username, setupCode}` returns `{name, role, secret, uri}` (the authenticator key to type in) and `POST /api/staff/setup/finish {username, setupCode, password(12+), code}` returns `{ok, recoveryCodes[10]}` once.
Signed in (any staff role): `POST /api/staff/password {current, next}`, `POST /api/staff/authenticator/start {password}` then `POST /api/staff/authenticator/confirm {code}`, `POST /api/staff/recovery-codes {password}`, and `POST /api/staff/mfa {recoveryCode}` as an alternative to `{code}`. `GET /api/staff/me` now also returns `username`, `recoveryCodesLeft`, `recovered`.
Administrators: `GET /api/admin/staff` (directory and pending requests), `POST /api/admin/staff/invite {name, username, role}`, `POST /api/admin/staff/{id}/disable`, `POST /api/admin/staff/{id}/reinvite`, `POST /api/admin/staff-requests/{id}/approve|cancel`. A response `{pending:true,id}` means a different administrator must approve; otherwise `{pending:false, action, username, setupCode?, validDays?}` where `setupCode` is shown once. Refusals: `GATE_USERNAME_TAKEN`, `GATE_BAD_DETAILS`, `GATE_SELF`, `GATE_TOO_FEW_ADMINS`, `SAME_ADMIN`, `NOT_FOUND`, `WRONG_PASSWORD`, `PASSWORD_TOO_SHORT`, `PASSWORD_UNCHANGED`, `BAD_CODE`.
