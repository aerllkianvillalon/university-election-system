#!/usr/bin/env bash
# Audit log: hash chain, insert-only, organization scoping, admin-only reading, chain check over HTTP, and detection of tampering.
set -u; DB=evaud; B=http://127.0.0.1:3061; E=aaaaaaaa-0000-4000-8000-000000000004; D=aaaaaaaa-0000-4000-8000-000000000005; O=cccccccc-0000-4000-8000-000000000031; O2=cccccccc-0000-4000-8000-000000000032
export STAFF_KEY=$(openssl rand -hex 32); F=0
ok() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (got '$2', want '$3')"; F=1; fi; }
dropdb --if-exists $DB 2>/dev/null; createdb $DB
# Migrations up to 0015 first, with audit rows already present, so the 0016 backfill is tested on existing data.
for f in db/migrations/shared/00{01..15}_*.sql; do psql -X -q -v ON_ERROR_STOP=1 $DB -f $f >/dev/null 2>&1 || { echo "migration $f failed"; exit 1; }; done
HASH=$(cd server && node tools.mjs hash 'staff-pass-123'); S1=$(openssl rand -hex 20); S3=$(openssl rand -hex 20); S4=$(openssl rand -hex 20)
enc() { (cd server && node tools.mjs enc $1); }
psql -X -q -v h="$HASH" $DB << SQL
INSERT INTO org.organizations(id,slug,name) VALUES ('$O','audorg','Audit Org'),('$O2','other','Other Org');
INSERT INTO election.elections(id,org_id,status,opens_at,closes_at) VALUES ('$E','$O','OPEN',now()-interval '1h',now()+interval '1h'),('$D','$O','DRAFT',now()+interval '1d',now()+interval '2d');
INSERT INTO admin.admins(org_id,name,username,role,password_hash,totp_secret) VALUES ('$O','Admin One','a1','ADMIN',:'h','\\x$(enc $S1)'),('$O','Proctor','p1','PROCTOR',:'h','\\x$(enc $S3)'),('$O2','Outsider','o1','ADMIN',:'h','\\x$(enc $S4)');
INSERT INTO ops.audit(staff_id,election_id,action,detail) SELECT id,'$E','OLD_ENTRY_'||n,'{"n":1}' FROM admin.admins, generate_series(1,2) n WHERE username='a1';
INSERT INTO ops.audit(staff_id,election_id,action,detail) SELECT id,NULL,'OLD_STAFF_ENTRY','{}' FROM admin.admins WHERE username='o1';
SQL
psql -X -q -v ON_ERROR_STOP=1 $DB -f db/migrations/shared/0016_audit_chain.sql >/dev/null 2>&1 || { echo "migration 0016 failed"; exit 1; }
q() { psql -X -tA $DB -c "$1"; }
ok "backfill: the 3 existing rows are chained 1..3 and verify" "$(q "select checked||' '||ok from ops.audit_verify()")" "3 true"
q "INSERT INTO ops.audit(staff_id,election_id,action,detail) SELECT id,'$E','NEW_ENTRY','{\"x\":\"y\"}' FROM admin.admins WHERE username='a1'" >/dev/null
ok "a new entry extends the chain (seq 4, linked to seq 3)" "$(q "select a.seq||' '||(a.prev_hash=b.entry_hash)::text from ops.audit a join ops.audit b on b.seq=3 where a.seq=4")" "4 true"
ok "the chain still verifies" "$(q "select ok from ops.audit_verify()")" "t"
# insert-only
ok "UPDATE is refused" "$(psql -X -tA $DB -c "update ops.audit set action='X' where seq=1" 2>&1 | grep -c AUDIT_IMMUTABLE)" 1
ok "DELETE is refused" "$(psql -X -tA $DB -c "delete from ops.audit where seq=2" 2>&1 | grep -c AUDIT_IMMUTABLE)" 1
ok "TRUNCATE is refused" "$(psql -X -tA $DB -c "truncate ops.audit" 2>&1 | grep -c AUDIT_IMMUTABLE)" 1
# concurrency: 20 parallel writers must produce one unbroken chain, no duplicate seq
for i in $(seq 1 20); do q "INSERT INTO ops.audit(action,detail) VALUES ('PARALLEL','{\"i\":$i}')" >/dev/null & done; wait
ok "20 parallel inserts: 24 entries, still one unbroken chain" "$(q "select checked||' '||ok from ops.audit_verify()")" "24 true"
ok "no duplicate sequence numbers" "$(q "select count(*)-count(distinct seq) from ops.audit")" 0

export DATABASE_URL="postgresql://app_api:devpass@127.0.0.1/$DB" PEPPER=p REQUEST_KEY=r RECEIPT_KEY=c ELECTION_PUBKEY=$(openssl rand -base64 32) PORT=3061 DEBUG_API=1
(cd server && exec node index.mjs >/tmp/aud.log 2>&1) & PID=$!; sleep 2; trap 'kill $PID 2>/dev/null' EXIT
declare -A TK; jar() { rm -f /tmp/t_$1.jar; TK[$1]=$(curl -s -c /tmp/t_$1.jar $B/api/csrf | sed 's/.*"token":"\([^"]*\)".*/\1/'); }
c() { local a=$1 m=$2 p=$3 d=${4:-}; ST=$(curl -s -o /tmp/to -w "%{http_code}" -b /tmp/t_$a.jar -c /tmp/t_$a.jar -H "X-CSRF-Token: ${TK[$a]}" -H 'Content-Type: application/json' -X $m $B$p ${d:+-d "$d"}); BODY=$(cat /tmp/to); }
jget() { python3 -c "import json,sys;d=json.loads(sys.stdin.read());print($1)"; }
for j in a1 p1 o1 anon; do jar $j; done
login() { c $1 POST /api/staff/login "{\"username\":\"$2\",\"password\":\"staff-pass-123\"}"; c $1 POST /api/staff/mfa "{\"code\":\"$(cd server && node tools.mjs code $3)\"}"; }
login a1 a1 $S1; login p1 p1 $S3; login o1 o1 $S4
c anon GET /api/admin/audit; ok "not signed in: refused" "$ST" 401
c p1 GET /api/admin/audit; ok "a proctor cannot read the audit log" "$ST" 403
c p1 GET /api/admin/audit/check; ok "a proctor cannot run the chain check" "$ST" 403
c a1 GET /api/admin/audit?limit=200; ok "admin sees this organization's entries only (3 election entries incl. NEW_ENTRY; not the other org's, not system rows)" "$(echo "$BODY" | jget "sorted(e['action'] for e in d['entries'])")" "['NEW_ENTRY', 'OLD_ENTRY_1', 'OLD_ENTRY_2']"
c a1 GET /api/admin/audit; ok "newest first, each entry shows who did it" "$(echo "$BODY" | jget "[d['entries'][0]['action'], d['entries'][0]['by']]")" "['NEW_ENTRY', 'a1']"
c o1 GET /api/admin/audit?limit=200; ok "the other organization sees only its own entry" "$(echo "$BODY" | jget "[e['action'] for e in d['entries']]")" "['OLD_STAFF_ENTRY']"
c a1 GET "/api/admin/audit?limit=1"; FIRST=$(echo "$BODY" | jget "d['entries'][0]['seq']"); c a1 GET "/api/admin/audit?limit=200&before=$FIRST"; ok "paging: 'before' returns only older entries" "$(echo "$BODY" | jget "sorted(e['seq'] for e in d['entries'])")" "[1, 2]"
c a1 GET "/api/admin/audit?action=NEW_ENTRY"; ok "filter by action" "$(echo "$BODY" | jget "len(d['entries'])")" 1
c a1 GET "/api/admin/audit?limit=0"; X1=$ST; c a1 GET "/api/admin/audit?limit=abc"; X2=$ST; c a1 GET "/api/admin/audit?action=bad;drop"; X3=$ST; c a1 GET "/api/admin/audit?before=1.5"; X4=$ST
ok "bad limit, bad action and bad cursor are 400" "$X1 $X2 $X3 $X4" "400 400 400 400"
c a1 GET /api/admin/audit/check; ok "chain check over HTTP: intact, counts all entries" "$(echo "$BODY" | jget "[d['ok'], d['checked']]")" "[True, 24]"
# Real actions through the API add entries that the reader then shows.
c a1 POST /api/admin/elections/$D/positions '{"title":"Treasurer","seats":1,"scope":{"all":true}}'
c a1 GET "/api/admin/audit?action=POSITION_ADD"; ok "a real admin action shows up in the log" "$(echo "$BODY" | jget "[len(d['entries']), d['entries'][0]['by'], d['entries'][0]['detail']]")" "[1, 'a1', {'title': 'Treasurer'}]"

# --- tampering by someone with full database access (they must disable the triggers first, which is exactly what the chain exposes) ---
psql -X -q $DB -c "alter table ops.audit disable trigger audit_no_change" -c "update ops.audit set detail='{\"n\":999}' where seq=2" -c "alter table ops.audit enable trigger audit_no_change" >/dev/null
ok "an edited row is caught, and the check says where it breaks (entry 2)" "$(q "select ok||' '||first_bad from ops.audit_verify()")" "false 2"
c a1 GET /api/admin/audit/check; ok "the HTTP check reports a broken chain" "$(echo "$BODY" | jget "[d['ok'], d['checked']]")" "[False, 1]"
psql -X -q $DB -c "alter table ops.audit disable trigger audit_no_change" -c "update ops.audit set detail='{\"n\":1}' where seq=2" -c "alter table ops.audit enable trigger audit_no_change" >/dev/null
ok "putting the row back restores the chain" "$(q "select ok from ops.audit_verify()")" "t"
psql -X -q $DB -c "alter table ops.audit disable trigger audit_no_change" -c "delete from ops.audit where seq=(select max(seq) from ops.audit)" -c "alter table ops.audit enable trigger audit_no_change" >/dev/null
ok "deleting the LAST entry is caught too (head no longer matches)" "$(q "select ok from ops.audit_verify()")" "f"
ok "app_api cannot read or write the audit table directly" "$(psql -X -tA "postgresql://app_api:devpass@127.0.0.1/$DB" -c "select count(*) from ops.audit" 2>&1 | grep -c 'permission denied')" 1
[ $F = 0 ] && echo "AUDIT OK" || echo "AUDIT FAILED"; exit $F
