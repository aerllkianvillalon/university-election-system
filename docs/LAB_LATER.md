# In-lab voting: how it is kept ready, and how to switch it on later

The first election is online only. Everything for lab voting that exists today is kept, tested and switched off.

## What is already built (and still tested)
- Database: lab booths, voting sessions, check-in/issue/start/cast functions, per-lab ballot chains, signed package export and import (`0007_lab.sql`, `0008_sync.sql`, `docs/spec/CHAIN.md`).
- Server: proctor and booth endpoints in `server/lab.mjs`, booth identity from a TLS client-certificate fingerprint.
- Lab worker: `apps/lab-worker/worker.mjs` (sealing, verifier, clock-jump freeze).
- Web app: kiosk (`/lab/booth`) and proctor (`/lab/proctor`) screens, still on mock data; a separate `VITE_TARGET=lab` build.

## The switches (all default to off)
| Where | Setting | Effect |
|---|---|---|
| API server | `LAB_ENABLED=1` and `LAB_SESSION_KEY` (64 hex) | mounts `/api/lab/*`; roll import accepts channel `LAB` |
| Web app (live central build) | `VITE_LAB_ENABLED=1` | includes the kiosk and proctor routes |
| Roll | `channel` per voter | `ONLINE` (default when lab is off) or `LAB` |

## What must be built before a real lab election (from TODO section 4 and 1)
1. Kiosk and proctor screens on the live endpoints (today mock).
2. Caddy configuration that really forwards the booth certificate and strips client copies of the header; `TRUST_CERT_HEADER` stays off until then.
3. Offline installer / Docker Compose bundle; the lab worker as a running service.
4. Lab audit chain, encrypted lab backups, restore onto a spare machine.
5. Two-connection concurrency test; power-cut and booth-crash tests.
6. Outbound roll package, delta packages, transfer forms, per-lab chains in the tally; `PACKAGE.md` and test vectors; `age` encryption.
7. Real lab hardware inspection and a key ceremony (people, not code).

## Keeping the door open while building the online system
- Do not remove the `channel` column, the lab tables or `server/lab.mjs`. The suites `lab sessions`, `packages`, `lab worker`, `booth` and `online-only` (its LAB_ENABLED=1 half) keep them honest.
- Any new voter-facing feature should say what it does for a LAB voter (usually: nothing, they vote at a booth).
