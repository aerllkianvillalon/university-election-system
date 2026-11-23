#!/usr/bin/env bash
# Online-only mode (the default): in-lab voting is switched off. Lab routes do not exist, a LAB voter is refused, a roll with no channel means ONLINE,
# and an election with no lab voters and no booths still reaches "ready" and can be locked by two administrators. Then the SAME roll is accepted once LAB_ENABLED=1.
set -u; DB=evonly; B=http://127.0.0.1:3062; E=aaaaaaaa-0000-4000-8000-000000000006; O=cccccccc-0000-4000-8000-000000000041; F=0
export STAFF_KEY=$(openssl rand -hex 32); unset LAB_ENABLED LAB_SESSION_KEY
ok() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (got '$2', want '$3')"; F=1; fi; }
dropdb --if-exists $DB 2>/dev/null; createdb $DB
for f in db/migrations/shared/*.sql; do psql -X -q -v ON_ERROR_STOP=1 $DB -f $f >/dev/null 2>&1 || { echo "migration $f failed"; exit 1; }; done
HASH=$(cd server && node tools.mjs hash 'staff-pass-123'); S1=$(openssl rand -hex 20); S2=$(openssl rand -hex 20); S3=$(openssl rand -hex 20)
enc() { (cd server && node tools.mjs enc $1); }
psql -X -q -v h="$HASH" $DB << SQL
INSERT INTO org.organizations(id,slug,name) VALUES ('$O','onlyorg','Online Org');
INSERT INTO election.elections(id,org_id,status,opens_at,closes_at) VALUES ('$E','$O','DRAFT',now()+interval '1 day',now()+interval '2 days');
INSERT INTO admin.admins(org_id,name,username,role,password_hash,totp_secret) VALUES ('$O','Admin One','a1','ADMIN',:'h','\\x$(enc $S1)'),('$O','Admin Two','a2','ADMIN',:'h','\\x$(enc $S2)'),('$O','Admin Three','a3','ADMIN',:'h','\\x$(enc $S3)');
SQL
W=/tmp/onlycer; rm -rf $W; node packages/cli/ev.mjs keygen --out $W >/dev/null
export DATABASE_URL="postgresql://app_api:devpass@127.0.0.1/$DB" PEPPER=p REQUEST_KEY=r RECEIPT_KEY=c ELECTION_PUBKEY=$(cat $W/election.pub) PORT=3062 DEBUG_API=1
start() { (cd server && exec node index.mjs >/tmp/only.log 2>&1) & PID=$!; sleep 2; }; start; trap 'kill $PID 2>/dev/null' EXIT
declare -A TK; jar() { rm -f /tmp/t_$1.jar; TK[$1]=$(curl -s -c /tmp/t_$1.jar $B/api/csrf | sed 's/.*"token":"\([^"]*\)".*/\1/'); }
c() { local a=$1 m=$2 p=$3 d=${4:-}; ST=$(curl -s -o /tmp/to -w "%{http_code}" -b /tmp/t_$a.jar -c /tmp/t_$a.jar -H "X-CSRF-Token: ${TK[$a]}" -H 'Content-Type: application/json' -X $m $B$p ${d:+-d "$d"}); BODY=$(cat /tmp/to); }
jget() { python3 -c "import json,sys;d=json.loads(sys.stdin.read());print($1)"; }; code_of() { echo "$BODY" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p'; }
for j in a1 a2 anon; do jar $j; done
login() { c $1 POST /api/staff/login "{\"username\":\"$2\",\"password\":\"staff-pass-123\"}"; c $1 POST /api/staff/mfa "{\"code\":\"$(cd server && node tools.mjs code $3)\"}"; }
login a1 a1 $S1; login a2 a2 $S2; R=/api/admin/elections/$E
c anon POST /api/lab/checkin '{}'; L1=$ST; c anon GET /api/lab/board; L2=$ST
ok "lab routes are not mounted (404, not a refusal that reveals them)" "$L1 $L2" "404 404"
c a1 POST $R/roll '{"rows":[{"studentId":"N1","channel":"ONLINE"},{"studentId":"N3","channel":"LAB"}]}'; ok "a LAB voter is refused whole, with a plain reason" "$ST $(code_of)" "400 LAB_DISABLED"
ok "nothing was imported by the refused roll" "$(psql -X -tA $DB -c "select count(*) from election.voters where election_id='$E'")" 0
c a1 POST $R/roll '{"rows":[{"studentId":"N1","attrs":{"program":"BSIT"}},{"studentId":"N2","channel":""},{"studentId":"N3","channel":"ONLINE"}]}'; ok "a roll with no channel is accepted and means ONLINE" "$ST $(echo "$BODY" | jget "d['inserted']")" "200 3"
ok "all three voters are ONLINE" "$(psql -X -tA $DB -c "select string_agg(distinct channel,',') from election.voters where election_id='$E'")" "ONLINE"
c a1 POST $R/roll '{"rows":[{"studentId":"N4","channel":"BOTH"}]}'; ok "an invalid channel is still reported as a row error" "$ST" 200
ok "...and imported nothing" "$(psql -X -tA $DB -c "select count(*) from election.voters where election_id='$E'")" 3
c a1 POST $R/positions '{"title":"President","seats":1,"scope":{"all":true}}'; POS=$(echo "$BODY" | jget "d['id']")
c a1 POST $R/candidates "{\"positionId\":\"$POS\",\"name\":\"Ana\"}"; c a1 POST $R/candidates "{\"positionId\":\"$POS\",\"name\":\"Ben\"}"
c a1 POST $R/key "{\"publicKey\":\"$(cat $W/election.pub)\"}"; c a1 POST $R/signing-key "{\"publicKey\":\"$(cat $W/signing.pub)\"}"
c a1 POST $R/vouchers/generate
c a1 GET $R/readiness; echo "  not ok: $(echo "$BODY" | jget "[x['name'] for x in d['checks'] if not x['ok']]")"; ok "ready with zero booths and zero lab voters (the lab check passes when there is no lab)" "$(echo "$BODY" | jget "[d['ready'], [x['detail'] for x in d['checks'] if x['name']=='lab_booths_registered'][0]]")" "[True, '0 enabled booths for 0 lab voters']"
c a1 POST $R/actions '{"action":"lock"}'; AP=$(echo "$BODY" | jget "d['approvalId']"); c a2 POST /api/admin/approvals/$AP/approve
ok "two administrators lock the election, online-only" "$(psql -X -tA $DB -c "select status from election.elections where id='$E'")" "LOCKED"
# the switch: with LAB_ENABLED=1 and a lab key the same LAB roll is allowed and the lab routes exist
kill $PID; sleep 1; E2=aaaaaaaa-0000-4000-8000-000000000007
psql -X -q $DB -c "INSERT INTO election.elections(id,org_id,status,opens_at,closes_at) VALUES ('$E2','$O','DRAFT',now()+interval '1 day',now()+interval '2 days')"
export LAB_ENABLED=1 LAB_SESSION_KEY=$(openssl rand -hex 32); start; for j in a3 anon; do jar $j; done; login a3 a3 $S3
c a3 POST /api/admin/elections/$E2/roll '{"rows":[{"studentId":"L1","channel":"LAB"}]}'; ok "with LAB_ENABLED=1 the same LAB voter is accepted" "$ST $(echo "$BODY" | jget "d['inserted']")" "200 1"
c anon POST /api/lab/checkin '{}'; ok "with LAB_ENABLED=1 the lab routes exist (they refuse an unregistered caller instead of 404)" "$([ "$ST" != 404 ] && echo yes)" yes
[ $F = 0 ] && echo "ONLINE-ONLY OK" || echo "ONLINE-ONLY FAILED"; exit $F
