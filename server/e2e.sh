#!/usr/bin/env bash
# End-to-end check: register -> login -> vote -> retry -> second nonce. Needs local Postgres; run from repo root.
set -u; DB=evapi; dropdb --if-exists $DB 2>/dev/null; createdb $DB
for f in db/migrations/shared/*.sql; do psql -X -q -v ON_ERROR_STOP=1 $DB -f $f >/dev/null || exit 1; done   # every migration, so this test cannot drift behind the schema
read E V < <(psql -X -tA $DB <<'SQL' | tr '|' ' '
WITH o AS (INSERT INTO org.organizations(slug,name) VALUES ('bsit','BS IT Society') RETURNING id),
e AS (INSERT INTO election.elections(org_id,status,opens_at,closes_at) SELECT id,'OPEN',now()-interval '1h',now()+interval '1h' FROM o RETURNING id),
v AS (INSERT INTO election.voters(election_id,student_id,channel,attrs) SELECT id,'2026-00001','ONLINE','{"program":"BSIT"}' FROM e RETURNING id,election_id),
x AS (INSERT INTO identity.vouchers SELECT id,hmac('DEMO-1','pepper','sha256'),now()+interval '1 day' FROM v)
SELECT election_id||'|'||id FROM v;
SQL
)
psql -X -q $DB -c "INSERT INTO election.positions(election_id,title,seats,scope,sort) VALUES ('$E','President',1,'{\"all\":true}',1),('$E','BSIT Rep',1,'{\"match\":{\"program\":\"BSIT\"}}',2),('$E','BSED Rep',1,'{\"match\":{\"program\":\"BSED\"}}',3)" -c "INSERT INTO election.candidates(election_id,position_id,name) SELECT election_id,id,'Cand '||g||' '||title FROM election.positions, generate_series(1,2) g"
BSED=$(psql -X -tA $DB -c "select id from election.positions where title='BSED Rep'"); export BSED
PUB=$(cd server && node -e "import('libsodium-wrappers').then(async s=>{await s.default.ready;console.log(Buffer.from(s.default.crypto_box_keypair().publicKey).toString('base64'))})")
export DATABASE_URL="postgresql://app_api:devpass@127.0.0.1/$DB" PEPPER=pepper REQUEST_KEY=rk RECEIPT_KEY=ck ELECTION_PUBKEY=$PUB PORT=3055
start() { (cd server && exec node index.mjs >/tmp/api.log 2>&1) & PID=$!; sleep 2; }; start
J=/tmp/jar; rm -f $J; B=http://127.0.0.1:3055; T=$(curl -s -c $J $B/api/csrf | sed 's/.*"token":"\([^"]*\)".*/\1/')
post() { curl -s -o /tmp/o -w "%{http_code} " -b $J -c $J -H "X-CSRF-Token: $T" -H 'Content-Type: application/json' -X POST $B$1 -d "$2"; cat /tmp/o | cut -c1-110; echo; }
echo "no csrf:"; curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/auth/login -H 'Content-Type: application/json' -d '{}'
echo "register wrong voucher:"; post /api/auth/register "{\"electionId\":\"$E\",\"studentId\":\"2026-00001\",\"voucher\":\"BAD\",\"password\":\"password123\",\"termsAccepted\":true}"
echo "register ok:";   post /api/auth/register "{\"electionId\":\"$E\",\"studentId\":\"2026-00001\",\"voucher\":\"DEMO-1\",\"password\":\"password123\",\"termsAccepted\":true}"
echo "register reuse:"; post /api/auth/register "{\"electionId\":\"$E\",\"studentId\":\"2026-00001\",\"voucher\":\"DEMO-1\",\"password\":\"password123\",\"termsAccepted\":true}"
echo "login wrong:";   post /api/auth/login "{\"electionId\":\"$E\",\"studentId\":\"2026-00001\",\"password\":\"nope\"}"
echo "login ok:";      post /api/auth/login "{\"electionId\":\"$E\",\"studentId\":\"2026-00001\",\"password\":\"password123\"}"
G=$(curl -s -b $J $B/api/elections/$E/ballot); export G
echo "BSIT voter sees: $(python3 server/mk.py titles)"
echo "tampered (out-of-scope contest):"; post /api/elections/$E/ballot "$(python3 server/mk.py tamper)"
echo "over-selection:"; post /api/elections/$E/ballot "$(python3 server/mk.py over)"
echo "missing contest:"; post /api/elections/$E/ballot "$(python3 server/mk.py missing)"
echo "valid ballot:"; post /api/elections/$E/ballot "$(python3 server/mk.py ok)"; RC=$(python3 -c "import json;print(json.load(open('/tmp/o'))['receipt'])")
echo "same nonce retry:"; post /api/elections/$E/ballot "$(python3 server/mk.py ok)"
echo "new nonce:"; post /api/elections/$E/ballot "$(N=22222222-2222-2222-2222-222222222222 python3 server/mk.py ok)"
g() { curl -s -w ' [%{http_code}]' "$@"; echo; }
echo "me:"; g -b $J $B/api/me; echo "public info:"; g $B/api/elections/$E/info | cut -c1-150; echo "info bad id:"; g $B/api/elections/not-a-uuid/info
echo "receipt before sealing:"; g $B/api/elections/$E/receipt/$RC; psql -X -q $DB -c "CALL ballots.seal('$E','main',1,true)"; echo "receipt after sealing:"; g $B/api/elections/$E/receipt/$RC; echo "unknown receipt:"; g $B/api/elections/$E/receipt/$(printf '0%.0s' $(seq 64))
psql -X -q $DB -c "UPDATE election.voters SET roll_email='roll@example.edu'"
echo "forgot (known):"; post /api/auth/forgot "{\"electionId\":\"$E\",\"studentId\":\"2026-00001\"}"
echo "forgot (unknown):"; post /api/auth/forgot "{\"electionId\":\"$E\",\"studentId\":\"9999\"}"
TOK=$(psql -X -tA $DB -c "select substring(body from 'token=([A-Za-z0-9_-]+)') from ops.outbox limit 1"); echo "outbox rows: $(psql -X -tA $DB -c 'select count(*) from ops.outbox') to=$(psql -X -tA $DB -c 'select to_email from ops.outbox')"
echo "GET validity (not consumed):"; curl -s $B/api/auth/reset/$TOK; echo; curl -s $B/api/auth/reset/$TOK; echo
echo "reset:"; post /api/auth/reset "{\"token\":\"$TOK\",\"newPassword\":\"newpassword456\"}"
echo "reset reuse:"; post /api/auth/reset "{\"token\":\"$TOK\",\"newPassword\":\"another-pass-789\"}"
echo "old session after reset:"; post /api/elections/$E/ballot "$(N=33333333-3333-3333-3333-333333333333 python3 server/mk.py ok)"
echo "login old pw:"; post /api/auth/login "{\"electionId\":\"$E\",\"studentId\":\"2026-00001\",\"password\":\"password123\"}"
echo "login new pw:"; post /api/auth/login "{\"electionId\":\"$E\",\"studentId\":\"2026-00001\",\"password\":\"newpassword456\"}"
echo "logout:"; post /api/auth/logout "{}"
for i in 1 2 3; do echo "bad login $i:"; post /api/auth/login "{\"electionId\":\"$E\",\"studentId\":\"2026-00001\",\"password\":\"x\"}"; done
echo "rows: participation=$(psql -X -tA $DB -c 'select count(*) from participation.participation') inbox=$(psql -X -tA $DB -c 'select count(*) from ballots.inbox')"
kill $PID
A="psql -X -tA postgresql://app_api:devpass@127.0.0.1/$DB"
for q in "ballots.inbox" "ballots.ballots" "participation.participation" "identity.vouchers" "admin.approvals"; do $A -c "select count(*) from $q" 2>&1 | grep -q "permission denied" && echo "PASS app_api cannot read $q"; done
psql -X -q -v ON_ERROR_STOP=1 $DB -f db/tests/lifecycle.sql 2>&1 | grep -E "PASS|ERROR|expected"
