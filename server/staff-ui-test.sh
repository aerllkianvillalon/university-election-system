#!/usr/bin/env bash
# Endpoints behind the staff console: who am I, the approval queue, withdrawing a request, signing out (and the session really dying).
set -u; DB=evsto; B=http://127.0.0.1:3060; E=aaaaaaaa-0000-4000-8000-000000000003; O=cccccccc-0000-4000-8000-000000000021; O2=cccccccc-0000-4000-8000-000000000022
export STAFF_KEY=$(openssl rand -hex 32); F=0
ok() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (got '$2', want '$3')"; F=1; fi; }
dropdb --if-exists $DB 2>/dev/null; createdb $DB
for f in db/migrations/shared/*.sql; do psql -X -q -v ON_ERROR_STOP=1 $DB -f $f >/dev/null 2>&1 || { echo "migration $f failed"; exit 1; }; done
HASH=$(cd server && node tools.mjs hash 'staff-pass-123'); S1=$(openssl rand -hex 20); S2=$(openssl rand -hex 20); S3=$(openssl rand -hex 20); S4=$(openssl rand -hex 20)
enc() { (cd server && node tools.mjs enc $1); }
psql -X -q -v h="$HASH" $DB << SQL
INSERT INTO org.organizations(id,slug,name) VALUES ('$O','stoorg','Console Org'),('$O2','other','Other Org');
INSERT INTO election.elections(id,org_id,status,opens_at,closes_at) VALUES ('$E','$O','OPEN',now()-interval '1h',now()+interval '1h');
INSERT INTO admin.admins(org_id,name,username,role,password_hash,totp_secret) VALUES ('$O','Admin One','a1','ADMIN',:'h','\\x$(enc $S1)'),('$O','Admin Two','a2','ADMIN',:'h','\\x$(enc $S2)'),('$O','Proctor','p1','PROCTOR',:'h','\\x$(enc $S3)'),('$O2','Outsider','o1','ADMIN',:'h','\\x$(enc $S4)');
SQL
export DATABASE_URL="postgresql://app_api:devpass@127.0.0.1/$DB" PEPPER=p REQUEST_KEY=r RECEIPT_KEY=c ELECTION_PUBKEY=$(openssl rand -base64 32) PORT=3060 DEBUG_API=1
(cd server && exec node index.mjs >/tmp/sto.log 2>&1) & PID=$!; sleep 2; trap 'kill $PID 2>/dev/null' EXIT
declare -A TK; jar() { rm -f /tmp/t_$1.jar; TK[$1]=$(curl -s -c /tmp/t_$1.jar $B/api/csrf | sed 's/.*"token":"\([^"]*\)".*/\1/'); }
c() { local a=$1 m=$2 p=$3 d=${4:-}; ST=$(curl -s -o /tmp/to -w "%{http_code}" -b /tmp/t_$a.jar -c /tmp/t_$a.jar -H "X-CSRF-Token: ${TK[$a]}" -H 'Content-Type: application/json' -X $m $B$p ${d:+-d "$d"}); BODY=$(cat /tmp/to); }
q() { psql -X -tA $DB -c "$1"; }; jget() { python3 -c "import json,sys;d=json.loads(sys.stdin.read());print($1)"; }; code_of() { echo "$BODY" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p'; }
for j in a1 a2 p1 o1 anon; do jar $j; done
login() { c $1 POST /api/staff/login "{\"username\":\"$2\",\"password\":\"staff-pass-123\"}"; c $1 POST /api/staff/mfa "{\"code\":\"$(cd server && node tools.mjs code $3)\"}"; }
R=/api/admin/elections/$E
c anon GET /api/staff/me; ok "not signed in: /me is refused" "$ST $(code_of)" "401 MFA_REQUIRED"
c a1 POST /api/staff/login "{\"username\":\"a1\",\"password\":\"staff-pass-123\"}"; c a1 GET /api/staff/me
ok "password only, no authenticator code yet: /me is still refused" "$ST" 401
login a1 a1 $S1; login a2 a2 $S2; login p1 p1 $S3; login o1 o1 $S4
c a1 GET /api/staff/me; ok "admin /me: name, role, organization, the organization's election" "$(echo "$BODY" | jget "[d['name'], d['role'], d['organization'], [(e['status'], e['paused']) for e in d['elections']]]")" "['Admin One', 'ADMIN', 'Console Org', [('OPEN', False)]]"
c p1 GET /api/staff/me; PM="$ST $(echo "$BODY" | jget "d['role']")"; c p1 GET $R/approvals; PA=$ST
ok "proctor can read /me but not the admin queue" "$PM $PA" "200 PROCTOR 403"
c o1 GET /api/staff/me; OM=$(echo "$BODY" | jget "[d['organization'], len(d['elections'])]"); c o1 GET $R/approvals; OA=$ST
ok "another organization's admin sees none of our elections and cannot read our queue" "$OM $OA" "['Other Org', 0] 403"
c a1 GET /api/admin/elections/not-a-uuid/approvals; N1=$ST; c a1 POST /api/admin/approvals/not-a-uuid/cancel; N2=$ST
ok "a malformed id is a 404, not a database error" "$N1 $N2" "404 404"

# --- queue, own-request rule, cancel ---
c a1 POST $R/actions '{"action":"pause"}'; AP=$(echo "$BODY" | jget "d['approvalId']")
c a1 GET $R/approvals; M1=$(echo "$BODY" | jget "[(x['action'], x['initiator'], x['mine']) for x in d['pending']]"); c a2 GET $R/approvals; M2=$(echo "$BODY" | jget "[x['mine'] for x in d['pending']]")
ok "a pending pause shows who asked; 'mine' is true for the requester only" "$M1 $M2" "[('pause', 'Admin One', True)] [False]"
c a1 POST /api/admin/approvals/$AP/approve; ok "the requester cannot approve their own request" "$ST $(code_of)" "409 SAME_ADMIN"
c p1 POST /api/admin/approvals/$AP/cancel; X1=$ST; c o1 POST /api/admin/approvals/$AP/cancel; X2=$ST
ok "a proctor and another organization's admin cannot cancel it" "$X1 $X2" "403 403"
c a2 POST /api/admin/approvals/$AP/cancel; X3=$ST; c a2 GET $R/approvals; X4=$(echo "$BODY" | jget "len(d['pending'])")
c a2 POST /api/admin/approvals/$AP/approve; X5="$ST $(code_of)"
ok "the other admin declines it: it leaves the queue and can no longer be approved" "$X3 $X4 $X5 $(q "select paused from election.elections where id='$E'")" "200 0 409 NOT_FOUND f"
c a1 POST $R/actions '{"action":"pause"}'; AP2=$(echo "$BODY" | jget "d['approvalId']"); c a1 POST /api/admin/approvals/$AP2/cancel
ok "the requester can withdraw their own request" "$ST $(q "select count(*) from admin.approvals where cancelled_at is not null")" "200 2"
c a1 POST $R/actions '{"action":"pause"}'; AP3=$(echo "$BODY" | jget "d['approvalId']"); c a2 POST /api/admin/approvals/$AP3/approve
ok "a fresh request approved by the other admin takes effect" "$ST $(q "select paused from election.elections where id='$E'")" "200 t"
c a1 GET $R/approvals; ok "recent history names both people; nothing pending" "$(echo "$BODY" | jget "[len(d['pending']), [(x['action'], x['initiator'], x['approver']) for x in d['recent']]]")" "[0, [('pause', 'Admin One', 'Admin Two')]]"
c a1 POST /api/admin/approvals/$AP3/cancel; ok "an executed request cannot be cancelled" "$ST $(code_of)" "409 NOT_FOUND"
ok "audit: both cancellations recorded" "$(q "select count(*) from ops.audit where action='REQUEST_CANCELLED'")" 2

# --- sign out ---
cp /tmp/t_a2.jar /tmp/t_a2old.jar; TK[a2old]=${TK[a2]}
c a2 POST /api/staff/logout; L1="$ST $(echo "$BODY" | jget "d['ok']")"; c a2 GET /api/staff/me; L2=$ST
c a2old GET /api/staff/me; L3="$ST $(code_of)"
ok "sign out: 200, the browser's session is gone, and a copied cookie is dead too (the server deleted the session)" "$L1|$L2|$L3" "200 True|401|401 MFA_REQUIRED"
c anon POST /api/staff/logout; L4=$ST; ST=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/api/staff/logout); L5=$ST
ok "sign out with no session is a harmless 200; without the CSRF token it is refused" "$L4 $L5" "200 403"
c a1 POST $R/freeze; FZ=$ST; c a1 GET /api/staff/me; F1=$(echo "$BODY" | jget "[(e['frozen'], e['freezeByMe'], e['freezeConfirmed']) for e in d['elections']]"); c p1 GET /api/staff/me; F2=$(echo "$BODY" | jget "[(e['frozen'], e['freezeByMe'], e['freezeConfirmed']) for e in d['elections']]")
ok "/me tells the console who froze voting (and that nobody has confirmed yet)" "$FZ $F1 $F2" "200 [(True, True, False)] [(True, False, False)]"
c a1 POST $R/ratify-freeze; F3="$ST $(code_of)"
ok "the administrator who froze it cannot confirm their own freeze" "$F3" "409 SAME_ADMIN_OR_BAD_STATE"
ok "the other admin's session is untouched by someone else's sign out" "$(c a1 GET /api/staff/me; echo $ST)" 200
[ $F = 0 ] && echo "ALL STAFF CONSOLE CHECKS PASS" || echo "SOME STAFF CONSOLE CHECKS FAILED"
