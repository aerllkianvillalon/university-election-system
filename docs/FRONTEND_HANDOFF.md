# Frontend handoff — CTU Danao Student Elections

The web app is a client of the real API (same-origin `/api`, HttpOnly cookies, CSRF header on writes). There is no mock or demo mode. Set `VITE_ELECTION_ID` at build time to choose the election; in dev and preview, `/api` is proxied to `API_PROXY_TARGET` (default `http://127.0.0.1:3001`).

All assets rendered by the website (Fontsource fonts, line-art hero and favicon) are local project files bundled by Vite. `app.config.ts` separately contains the HTTPS logo URL required for Manus project-level metadata.

## Route map

| Route | Purpose | Important state/behavior |
| --- | --- | --- |
| `/` | Landing | Current election status and window |
| `/election` | Election overview | Dates, eligibility guidance and status from the server |
| `/candidates` | Candidate profiles | Shown after sign-in (the ballot depends on the voter); never displays vote totals |
| `/register` | Registration | Student ID, voucher, password and required Terms checkbox |
| `/login` | Sign-in | Generic errors; no account-existence disclosure |
| `/forgot-password` | Recovery request | Same generic failure behavior; non-enumerating success copy |
| `/reset-password` | Password reset | One-time token read from the link, checked on arrival |
| `/status` | Eligibility and ballot status | Aggregate-only status for the signed-in voter |
| `/results` | Certified results | Locked until two admins certify; shows counts and the signed proof |
| `/vote` | Ballot wizard | One contest per step, seat limit, mutually exclusive abstain, progress, review and irreversible warning |
| `/receipt` | Confirmation receipt | Hash/reference only; “recorded” → “sealed”; no selections |
| `/help/:kind` | Support forms | claim, protest, dispute, report (old addresses redirect) |
| `/staff/login`, `/staff/setup`, `/staff` | Staff console | `/admin` redirects to `/staff` |
| `/legal/:slug` | Privacy, terms, election rules, accessibility | Text should be reviewed by the Electoral Committee |

## State and data behavior

Ballot selections are held only in memory and `sessionStorage` with a short expiry; no application code uses `localStorage`. Drafts are tagged with their election so a ballot from one election cannot be restored into another. They are cleared on submit, expiry and sign-out.

In-lab voting (kiosk and proctor screens) is not part of the web app yet; see `docs/LAB_LATER.md`.

## Guarantees required before any live election

The frontend does not enforce security. The server must guarantee all of the following:

1. Authenticate students safely; validate Student ID/voucher without exposing whether identities, accounts, vouchers, or recovery targets exist; enforce role separation for students, proctors, administrators, and certifiers.
2. Verify voter eligibility against an approved immutable voter-roll snapshot; prevent duplicate voting, replay, cross-organization access, election-ID substitution, channel misuse, and unauthorized booth assignment.
3. Accept ballots atomically and anonymously; cryptographically separate identity/eligibility evidence from selections; validate contest/seat limits, abstention, election window, election freeze/pause/expiry and channel rules; reject tampered/replayed submissions.
4. Keep selections private from the public, candidate profiles, proctor station, administrators, and turnout APIs. Expose only aggregate turnout to operational roles before certification; never expose candidate totals until the election is formally certified.
5. Store submitted ballots durably with integrity protection, signed/cryptographic audit events, idempotent receipt handling, privacy-preserving receipt verification, recovery procedures, defined retention/deletion, and independent backup/restore.
6. Generate a receipt only after durable acceptance and verification; keep the receipt free of choices and personal data; use “recorded” and “sealed” states only when each backend guarantee has actually occurred.
7. Enforce two distinct, authenticated administrator approvals for freeze, pause, extend, close, and certification, with separation of duties, replay protection, step-up authentication, audit trail, and clear rollback/escalation rules.
8. Validate all roster imports server-side for authorization, file type/size/schema, duplication, malware and data minimization; never trust browser CSV previews. Keep PII out of logs and telemetry.
9. Publish results only from a signed, formally certified result package after the challenge window and approvals; make pre-certification result APIs deny by default.
10. Apply rate limits, CSRF/session protections, TLS, secure cookies, anti-automation controls, accessible step-up/support paths, incident alarms, service recovery plans, and privacy/security review appropriate to an official election.
11. Enforce WCAG 2.1 AA and provide accessible assisted and kiosk voting modes; ensure offline handling cannot make a submitted ballot appear accepted when it was not.

## Operations

Local development: `pnpm dev` (port 3000, needs the API server). Type checking: `pnpm typecheck`. Build: `pnpm build`. End-to-end tests against a real API and Postgres: `pnpm test:live`. Bundle budget: `pnpm size`, capped at 250 KB gzipped per emitted JavaScript asset. Route declaration: `public/manus-routes.json` must remain synchronized with the routes above and return JSON over HTTP.
