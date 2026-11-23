#!/usr/bin/env bash
# Runs every suite and prints one PASS/FAIL line per check. Needs local Postgres (service postgresql start). Run from repo root.
cd "$(dirname "$0")/.."; F=0; T=/tmp/runall; mkdir -p $T
chk() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (got $2, want $3)"; F=1; fi; }
n() { grep -c -E "$1" "$2"; }
bash db/tests/smoke.sh > $T/smoke 2>&1;      chk "smoke: reserved slug, normalized name, insert-only ballots" "$(n '^PASS' $T/smoke)" 3
chk "smoke: 50 parallel submits -> 1 participation, 1 inbox, chain intact" "$(n 'participation=1 inbox=1|verify_bad=0' $T/smoke)" 2
bash server/e2e.sh > $T/e2e 2>&1
chk "api: register/login/CSRF/uniform errors" "$(n 'register ok:|login ok:|^403' $T/e2e)" 3
chk "api: scope (tamper/over/missing rejected, valid ok, retry same receipt, 2nd nonce refused)" "$(n '^400 .*VALIDATION_FAILED|^200 \{"receipt|ALREADY_VOTED' $T/e2e)" 6
chk "api: forgot/reset/rate limit/logout" "$(n '^202|RESET_LINK_EXPIRED|RATE_LIMITED|valid":true' $T/e2e)" 7
chk "voter API: /me, public info, 404 on bad id, receipt recorded -> sealed, unknown receipt" "$(n 'hasVoted":true\} \[200\]|"status":"OPEN"|\[404\]|"recorded":true,"sealed":false|"recorded":true,"sealed":true|"recorded":false' $T/e2e)" 6
chk "least privilege: app_api cannot read 5 protected tables" "$(n 'PASS app_api cannot read' $T/e2e)" 5
chk "lifecycle: gates, two-admin approval, freeze auto-lift" "$(n 'PASS lifecycle' $T/e2e)" 1
dropdb --if-exists evlab 2>/dev/null; createdb evlab; for f in db/migrations/shared/*.sql; do psql -X -q -v ON_ERROR_STOP=1 evlab -f $f >/dev/null 2>&1 || echo "migration $f failed"; done
psql -X -q -v ON_ERROR_STOP=1 evlab -f db/tests/lab.sql > $T/lab 2>&1; chk "lab sessions: all rejection paths" "$(n 'PASS lab' $T/lab)" 1
bash server/cli-test.sh > $T/cli 2>&1;       chk "ceremony+tally: verify, tally, signature" "$(n 'OK chain main: 7|OK tallied 7|OK results signature valid' $T/cli)" 3
chk "ceremony+tally: 6 negative cases rejected" "$(n "^FAIL" $T/cli)" 6
bash server/vectors-test.sh > $T/vec 2>&1;   chk "chain vectors: SQL and JS agree" "$(n '^OK' $T/vec)" 2
bash server/pkg-test.sh > $T/pkg 2>&1;       chk "packages: 2 imports (interim, cumulative final)" "$(n 'OK imported' $T/pkg)" 2
chk "packages: 6 rejections + atomic (nothing left behind)" "$(n 'REJECTED' $T/pkg)" 6
chk "packages: replays are no-ops" "$(n 'NO-OP' $T/pkg)" 2
bash server/worker-test.sh > $T/wk 2>&1;     chk "lab worker: sealing rules, clock faults, tamper freeze" "$(n '^PASS' $T/wk)" 6
bash server/http-test.sh > $T/http 2>&1; sed '/^30 roll/,$d' $T/http > $T/http1   # steps 1-29: staff, booth, freeze
chk "staff: MFA required, wrong/reused code refused, proctor blocked from admin" "$(n 'MFA_REQUIRED|^403 .*FORBIDDEN|^200 \{"ok":true\}$' $T/http1)" 8
chk "booth: certificate identity, wrong booth, tamper, cast once, reuse refused" "$(n 'BOOTH_NOT_REGISTERED|WRONG_BOOTH|VALIDATION_FAILED|"receipt"|"code":"REUSED"' $T/http1)" 5
chk "admin: freeze blocks lab, self-ratify/self-approve refused, second admin works" "$(n '"code":"FROZEN"|SAME_ADMIN_OR_BAD_STATE|"code":"SAME_ADMIN"|^200 \{"approvalId"' $T/http1)" 4
chk "booth session token is cleared after the vote" "$(n '^20 token cleared from DB: 0 rows' $T/http)" 1
chk "admin manage: bad roll rejected whole, good roll imported, edits refused after LOCKED" "$(n '"reason":"DUPLICATE_IN_FILE"|"inserted":3|"code":"GATE_LOCKED"' $T/http)" 3
chk "admin manage: vouchers issued once and usable to register, election and signing keys validated" "$(n '"issued":2|"issued":0|^36 voter|"fingerprint"' $T/http)" 5
chk "admin manage: readiness false then true, lock via two admins, other-org admin refused" "$(n '"ready":true|^  status: LOCKED|^ERROR:  FORBIDDEN' $T/http)" 3
bash server/support-test.sh > $T/sup 2>&1;   chk "support forms, staff queue, claim codes: 37 checks pass (record-only forms, no roll leak, limits, org/role isolation, hash-only codes, lockout reset, audit, app_api blind, DB error is a 500 not a crash)" "$(n '^PASS' $T/sup)" 37
chk "support forms, staff queue, claim codes: no failing check" "$(n '^FAIL' $T/sup)" 0
bash server/results-test.sh > $T/res 2>&1;   chk "results pipeline: 37 checks pass (real keys, votes, seal, export, 3-share tally, forged files refused, two-admin certify, public counts re-verified offline)" "$(n '^PASS' $T/res)" 37
chk "results pipeline: no failing check" "$(n '^FAIL' $T/res)" 0
bash server/staff-ui-test.sh > $T/sto 2>&1;   chk "staff console API: 20 checks pass (who am I, role and organization limits, queue, own-request rule, cancel, history, sign-out kills the server session)" "$(n '^PASS' $T/sto)" 20
chk "staff console API: no failing check" "$(n '^FAIL' $T/sto)" 0
bash server/staff-accounts-test.sh > $T/acc 2>&1;   chk "staff accounts: 56 checks pass (setup tool, one-time setup, password/authenticator/recovery, two-person invite/disable/re-invite, nothing stored in the clear)" "$(n '^PASS' $T/acc)" 56
chk "staff accounts: no failing check" "$(n '^FAIL' $T/acc)" 0
bash server/audit-test.sh > $T/aud 2>&1;   chk "audit log: 24 checks pass (backfill, hash chain, insert-only, 20 parallel writers, org scoping, admin-only, paging, tamper and tail-deletion detected)" "$(n "^PASS" $T/aud)" 24
chk "audit log: no failing check" "$(n '^FAIL' $T/aud)" 0
bash server/online-only-test.sh > $T/only 2>&1;   chk "online-only: 11 checks pass (lab routes absent, LAB voter refused, no channel means ONLINE, ready and lockable with no lab, LAB_ENABLED=1 switches it back on)" "$(n "^PASS" $T/only)" 11
chk "online-only: no failing check" "$(n '^FAIL' $T/only)" 0
node --test tests/results-rank.test.ts > $T/unit 2>&1;   chk "results labelling unit tests: 13 pass (ties, zero votes, multi-seat, unopposed, empty)" "$(grep -c '^# pass 13$' $T/unit)" 1
chk "results labelling unit tests: none fail" "$(grep -c '^# fail 0' $T/unit)" 1
[ $F = 0 ] && echo "ALL SUITES PASS" || echo "SOME CHECKS FAILED"
