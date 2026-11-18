# Frontend handoff — CTU Danao Student Elections

## Scope and safety boundary

This is a frontend-only prototype. Every election record, identity, candidate, receipt, result, count, roster, approval, and status is mock data. No action submits a real vote or communicates with an election service. Do not enter real student credentials, vouchers, or selections. All feature screens call the typed mock client (`src/lib/api/client.ts`) and its request/response contracts live in `src/lib/api/types.ts`; only the client imports `src/lib/api/mock-data.ts`.

`VITE_TARGET=central` builds the standard student-facing app with the scripted election-help chatbot. `VITE_TARGET=lab` redirects `/` to the kiosk, omits the chatbot, and the frontend uses no fetch/XHR or other application network client. Asset paths must remain bundled/project-local and must not be swapped for third-party CDN URLs. Fontsource fonts are packaged with Vite.

All assets rendered by the website (Fontsource fonts, candidate portraits, line-art hero and favicon) are local project files bundled by Vite. `app.config.ts` separately contains the HTTPS logo URL required for Manus project-level metadata; the app does not import, render or request that platform metadata asset.

## Route map

| Route | Purpose | Important state/behavior |
| --- | --- | --- |
| `/` | Landing and organization chooser | Current cycle, aggregate eligibility context, mock-data disclosure |
| `/election?org=:organizationId` | Organization election overview | Dates, eligibility guidance and status resolved by the typed client for that organization |
| `/candidates?org=:organizationId` | Candidate profiles | Organization-specific fictional portraits and tags; never displays vote totals |
| `/register` | Registration prototype | Student ID, voucher, password and required Terms checkbox |
| `/login` | Sign-in prototype | Generic errors; no account-existence disclosure |
| `/forgot-password` | Recovery request | Same generic failure behavior; non-enumerating success copy |
| `/reset-password` | Password-reset mock page | Local demo success state only |
| `/status?org=:organizationId` | Eligibility and ballot status | Aggregate-only status for the selected organization, including “We are checking your vote.” |
| `/results` | Results archive | Active election locked; results demo only for a `Certified` fixture |
| `/vote?org=:organizationId` | Ballot wizard | Organization-specific contests; one contest per step, seat limit, mutually exclusive abstain, progress, review and irreversible warning |
| `/receipt` | Confirmation receipt | Hash/reference only; state transitions “recorded” → “sealed”; no selections |
| `/lab/booth` | Kiosk | Idle, waiting, wizard, auto-reset; reset clears session ballot state |
| `/lab/proctor?org=:organizationId` | Proctor station | Organization-scoped ID check-in, booth board, issue/cancel, alarms and aggregate counts only |
| `/admin` | (redirect) | Goes to `/staff`, the real staff console |
| `/legal/privacy` | Privacy sample | Demo boundary and data handling |
| `/legal/terms` | Terms sample | Prototype-only use |
| `/legal/election-rules` | Election rules sample | Eligibility, ballot and certification notes |
| `/legal/accessibility` | Accessibility statement | Accessibility intent and support guidance |

## State and data behavior

Ballot selections are held only in memory and `sessionStorage` with a short expiry; no application code uses `localStorage`. Drafts are tagged with their election context so a ballot from one organization cannot be restored into another election. Draft selections clear after simulated submission, expiry, sign-out, organization-context mismatch, and kiosk reset. The typed client’s receipt object contains only a mock reference/hash/time/state and does not contain candidate selections. In-memory receipt state is transient. Forms have client-side checks; login, registration, and forgot-password failures display the same generic error copy.

The two demo build targets are selected at build time using `VITE_TARGET=central|lab`. The app does not issue runtime HTTP requests for its mock records. Lab mode hides the chatbot and begins at the booth kiosk; no network API calls are made from the lab frontend.

`/election`, `/candidates`, `/status`, and `/vote` accept an `org` query parameter. The demo client resolves it to a mock organization/election pair; unknown values fall back to the first fixture so the prototype remains navigable. A live backend must instead reject unknown IDs and authorize every requested organization/election against the authenticated student, administrator, proctor or certifier role. Ballot submission and draft recovery must be scoped to one immutable election ID.

## Guarantees required before any live election

These frontend simulations do not enforce security. Before integrating an authoritative backend, it must guarantee all of the following server-side:

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

Local development: `pnpm dev` (port 3000). Type checking: `pnpm typecheck`. Builds: `pnpm build:central` and `pnpm build:lab`. Accessibility test suite: `pnpm test:a11y` (axe scans every declared route at mobile and desktop sizes and asserts 48px inline-link targets). Interaction checks: `pnpm exec playwright test tests/flows.spec.ts` covers organization-specific elections/proctor boards, abstain exclusivity, ballot privacy/receipt sealing, non-empty uniform auth errors, result certification gating, dual approval, admin fixtures, and kiosk auto-reset/full width. Offline-lab smoke check: build the lab target, then run `pnpm test:lab`; it requires `/` to land in the full-screen booth, hides chat, and verifies there are no external, fetch/XHR, websocket, event-stream, or ping requests. Bundle budget: `pnpm size`, capped at 250 KB gzipped per emitted JavaScript asset. Route declaration: `public/manus-routes.json` must remain synchronized with the routes above and return JSON over HTTP.
