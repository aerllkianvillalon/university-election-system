#!/usr/bin/env bash
# Staff login + MFA, admin controls (two-admin rule, freeze/ratify), proctor station and booth kiosk (certificate identity), end to end over HTTP.
set -u; DB=evhttp; B=http://127.0.0.1:3057; E=aaaaaaaa-0000-4000-8000-000000000001; O=cccccccc-0000-4000-8000-000000000001
export STAFF_KEY=$(openssl rand -hex 32) LAB_SESSION_KEY=$(openssl rand -hex 32) LAB_ENABLED=1
dropdb --if-exists $DB 2>/dev/null; createdb $DB
for f in db/migrations/shared/*.sql; do psql -X -q -v ON_ERROR_STOP=1 $DB -f $f >/dev/null 2>&1 || { echo "migration $f failed"; exit 1; }; done
HASH=$(cd server && node tools.mjs hash 'staff-pass-123'); S1=$(openssl rand -hex 20); S2=$(openssl rand -hex 20); S3=$(openssl rand -hex 20)
E1=$(cd server && node tools.mjs enc $S1); E2=$(cd server && node tools.mjs enc $S2); E3=$(cd server && node tools.mjs enc $S3)
psql -X -q -v h="$HASH" $DB << SQL
INSERT INTO org.organizations(id,slug,name) VALUES ('$O','httporg','Http Org'),('cccccccc-0000-4000-8000-000000000002','other','Other Org');
INSERT INTO election.elections(id,org_id,status,opens_at,closes_at) VALUES ('$E','$O','OPEN',now()-interval '1h',now()+interval '1h');
INSERT INTO election.voters(id,election_id,student_id,channel,attrs) VALUES ('dddddddd-0000-4000-8000-000000000001','$E','S1','LAB','{"program":"BSIT"}'),('dddddddd-0000-4000-8000-000000000002','$E','S2','LAB','{"program":"BSIT"}'),('dddddddd-0000-4000-8000-000000000003','$E','S3','ONLINE','{"program":"BSIT"}');
INSERT INTO election.positions(id,election_id,title,seats,scope,sort) VALUES ('11111111-0000-4000-8000-000000000001','$E','President',1,'{"all":true}',1),('11111111-0000-4000-8000-000000000002','$E','BSIT Rep',1,'{"match":{"program":"BSIT"}}',2),('11111111-0000-4000-8000-000000000003','$E','BSED Rep',1,'{"match":{"program":"BSED"}}',3);
INSERT INTO election.candidates(election_id,position_id,name) SELECT election_id,id,'Cand '||g||' '||title FROM election.positions, generate_series(1,2) g;
INSERT INTO election.elections(id,org_id,status) VALUES ('aaaaaaaa-0000-4000-8000-000000000002','$O','DRAFT');
INSERT INTO lab.booths(id,label,cert_fingerprint) VALUES ('eeeeeeee-0000-4000-8000-000000000001','B1','AA:AA'),('eeeeeeee-0000-4000-8000-000000000002','B2','BB:BB');
INSERT INTO admin.admins(org_id,name,username,role,password_hash,totp_secret) VALUES ('$O','Admin One','a1','ADMIN',:'h','\x$E1'),('$O','Admin Two','a2','ADMIN',:'h','\x$E2'),('$O','Proctor','p1','PROCTOR',:'h','\x$E3');
SQL
node packages/cli/ev.mjs keygen --out /tmp/httpcer >/dev/null
export DATABASE_URL="postgresql://app_api:devpass@127.0.0.1/$DB" PEPPER=p REQUEST_KEY=r RECEIPT_KEY=c ELECTION_PUBKEY=$(cat /tmp/httpcer/election.pub) TRUST_CERT_HEADER=1 PORT=3057
(cd server && exec node index.mjs >/tmp/http.log 2>&1) & PID=$!; sleep 2
declare -A TK; jar() { rm -f /tmp/h_$1.jar; TK[$1]=$(curl -s -c /tmp/h_$1.jar $B/api/csrf | sed 's/.*"token":"\([^"]*\)".*/\1/'); }
c() { local a=$1 m=$2 p=$3 d=${4:-} h=${5:-X-None:1}; curl -s -o /tmp/o -w "%{http_code} " -b /tmp/h_$a.jar -c /tmp/h_$a.jar -H "X-CSRF-Token: ${TK[$a]}" -H "$h" -H 'Content-Type: application/json' -X $m $B$p ${d:+-d "$d"}; cut -c1-110 /tmp/o; echo; }
code() { (cd server && node tools.mjs code $1); }
login() { jar $1; c $1 POST /api/staff/login "{\"username\":\"$2\",\"password\":\"${4:-staff-pass-123}\"}"; }
for a in p a1 a2 b1 b2; do jar $a; done
echo "1 staff login wrong password:"; login x p1 "" wrong
echo "2 proctor logged in but no MFA yet -> checkin:"; login p p1 "" ; c p POST /api/lab/checkin "{\"electionId\":\"$E\",\"studentId\":\"S1\"}"
echo "3 wrong MFA code:"; c p POST /api/staff/mfa '{"code":"000000"}'
CODE=$(code $S3); echo "4 right MFA code:"; c p POST /api/staff/mfa "{\"code\":\"$CODE\"}"
echo "5 same code reused on a fresh login:"; login p2 p1 ""; c p2 POST /api/staff/mfa "{\"code\":\"$CODE\"}"
echo "6 checkin S1 (lab voter):"; c p POST /api/lab/checkin "{\"electionId\":\"$E\",\"studentId\":\"S1\"}"
echo "7 checkin S3 (online voter):"; c p POST /api/lab/checkin "{\"electionId\":\"$E\",\"studentId\":\"S3\"}"
echo "8 proctor tries an admin endpoint:"; c p GET /api/admin/elections/$E/turnout
echo "9 issue S1 to booth B1:"; c p POST /api/lab/issue "{\"electionId\":\"$E\",\"voterId\":\"dddddddd-0000-4000-8000-000000000001\",\"boothId\":\"eeeeeeee-0000-4000-8000-000000000001\"}"
echo "10 unregistered booth cert polls:"; c b1 GET /api/lab/booth/poll "" "X-Client-Cert-Fingerprint: ZZ:ZZ"
echo "11 B1 polls:"; c b1 GET /api/lab/booth/poll "" "X-Client-Cert-Fingerprint: AA:AA"; TOK=$(python3 -c "import json;print(json.load(open('/tmp/o'))['sessionToken'])")
echo "12 B2 polls (nothing for it):"; c b2 GET /api/lab/booth/poll "" "X-Client-Cert-Fingerprint: BB:BB"
echo "13 B2 tries to start B1's session:"; c b2 POST /api/lab/booth/start "{\"sessionToken\":\"$TOK\"}" "X-Client-Cert-Fingerprint: BB:BB"
echo "14 B1 starts:"; c b1 POST /api/lab/booth/start "{\"sessionToken\":\"$TOK\"}" "X-Client-Cert-Fingerprint: AA:AA"; export G=$(cat /tmp/o); export BSED=11111111-0000-4000-8000-000000000003
mkb() { python3 server/mk.py $1 | python3 -c "import json,sys,os;d=json.load(sys.stdin);d['sessionToken']=os.environ['TOK'];print(json.dumps(d))"; }; export TOK
echo "15 tampered (out-of-scope contest):"; c b1 POST /api/lab/booth/cast "$(mkb tamper)" "X-Client-Cert-Fingerprint: AA:AA"
echo "16 valid cast:"; c b1 POST /api/lab/booth/cast "$(mkb ok)" "X-Client-Cert-Fingerprint: AA:AA"
echo "17 cast again with same token:"; c b1 POST /api/lab/booth/cast "$(mkb ok)" "X-Client-Cert-Fingerprint: AA:AA"
echo "18 board (aggregate only):"; c p GET "/api/lab/board?electionId=$E"
echo "19 checkin S1 again:"; c p POST /api/lab/checkin "{\"electionId\":\"$E\",\"studentId\":\"S1\"}"
echo "20 token cleared from DB: $(psql -X -tA $DB -c 'select count(*) from lab.voting_sessions where token_enc is not null') rows still hold a token"
login a1 a1 ""; c a1 POST /api/staff/mfa "{\"code\":\"$(code $S1)\"}" >/dev/null; login a2 a2 ""; c a2 POST /api/staff/mfa "{\"code\":\"$(code $S2)\"}" >/dev/null
echo "21 admin turnout:"; c a1 GET /api/admin/elections/$E/turnout
echo "22 a1 freezes:"; c a1 POST /api/admin/elections/$E/freeze
echo "23 checkin while frozen:"; c p POST /api/lab/checkin "{\"electionId\":\"$E\",\"studentId\":\"S2\"}"
echo "24 a1 ratifies own freeze:"; c a1 POST /api/admin/elections/$E/ratify-freeze
echo "25 a2 ratifies:"; c a2 POST /api/admin/elections/$E/ratify-freeze
echo "26 a1 requests unfreeze:"; c a1 POST /api/admin/elections/$E/actions '{"action":"unfreeze"}'; AP=$(python3 -c "import json;print(json.load(open('/tmp/o'))['approvalId'])")
echo "27 a1 approves own request:"; c a1 POST /api/admin/approvals/$AP/approve
echo "28 a2 approves:"; c a2 POST /api/admin/approvals/$AP/approve
echo "29 checkin after unfreeze:"; c p POST /api/lab/checkin "{\"electionId\":\"$E\",\"studentId\":\"S2\"}"
E2=aaaaaaaa-0000-4000-8000-000000000002; R=/api/admin/elections/$E2
echo "30 roll with errors is rejected whole:"; c a1 POST $R/roll '{"rows":[{"studentId":"N1","channel":"ONLINE"},{"studentId":"N1","channel":"ONLINE"},{"studentId":"N2","channel":"BOTH"}]}'; echo "  voters inserted: $(psql -X -tA $DB -c "select count(*) from election.voters where election_id='$E2'")"
echo "31 good roll:"; c a1 POST $R/roll '{"rows":[{"studentId":"N1","channel":"ONLINE","email":"n1@x.edu","attrs":{"program":"BSIT"}},{"studentId":"N2","channel":"ONLINE"},{"studentId":"N3","channel":"LAB"}]}'
echo "32 position + 2 candidates:"; c a1 POST $R/positions '{"title":"President","seats":1,"scope":{"all":true}}'; PID2=$(python3 -c "import json;print(json.load(open('/tmp/o'))['id'])")
c a1 POST $R/candidates "{\"positionId\":\"$PID2\",\"name\":\"Ana\"}"; c a1 POST $R/candidates "{\"positionId\":\"$PID2\",\"name\":\"Ben\",\"platform\":\"Open labs\"}"
echo "33 readiness before key/window/vouchers:"; c a1 GET $R/readiness
psql -X -q $DB -c "UPDATE election.elections SET opens_at=now()+interval '1 day', closes_at=now()+interval '2 days' WHERE id='$E2'"
echo "34 generate vouchers:"; c a1 POST $R/vouchers/generate; VC=$(python3 -c "import json;d=json.load(open('/tmp/o'));print(d['vouchers'][0]['studentId']+' '+d['vouchers'][0]['code'])")
echo "35 generate again (none left):"; c a1 POST $R/vouchers/generate
echo "36 voter registers with the issued voucher:"; jar v; c v POST /api/auth/register "{\"electionId\":\"$E2\",\"studentId\":\"${VC% *}\",\"voucher\":\"${VC#* }\",\"password\":\"voter-pass-123\",\"termsAccepted\":true}"
echo "37 same voucher again:"; c v POST /api/auth/register "{\"electionId\":\"$E2\",\"studentId\":\"${VC% *}\",\"voucher\":\"${VC#* }\",\"password\":\"voter-pass-123\",\"termsAccepted\":true}"
echo "38 set election key (bad length, then good):"; c a1 POST $R/key '{"publicKey":"AAAA"}'; c a1 POST $R/key "{\"publicKey\":\"$(cat /tmp/httpcer/election.pub)\"}"
echo "38b set signing key (bad length, then good):"; c a1 POST $R/signing-key '{"publicKey":"AAAA"}'; c a1 POST $R/signing-key "{\"publicKey\":\"$(cat /tmp/httpcer/signing.pub)\"}"
echo "39 readiness now:"; c a1 GET $R/readiness
echo "40 lock: a1 requests, a2 approves:"; c a1 POST $R/actions '{"action":"lock"}'; AP2=$(python3 -c "import json;print(json.load(open('/tmp/o'))['approvalId'])"); c a2 POST /api/admin/approvals/$AP2/approve; echo "  status: $(psql -X -tA $DB -c "select status from election.elections where id='$E2'")"
echo "41 roll edit after lock:"; c a1 POST $R/roll '{"rows":[{"studentId":"N9","channel":"LAB"}]}'
echo "42 admin of another organization:"; psql -X -q $DB -c "INSERT INTO admin.admins(id,org_id,name) VALUES ('99999999-0000-4000-8000-000000000001','cccccccc-0000-4000-8000-000000000002','Outsider')"; psql -X -tA $DB -c "SELECT admin.readiness('$E2','99999999-0000-4000-8000-000000000001')" 2>&1 | head -1 | cut -c1-60
echo "43 audit rows written: $(psql -X -tA $DB -c 'select count(*) from ops.audit')"
kill $PID
