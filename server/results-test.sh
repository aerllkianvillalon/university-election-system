#!/usr/bin/env bash
# Results, end to end, with the real tools: ceremony keys -> real votes over HTTP -> close (2 admins) -> seal -> ev export-ballots -> ev tally (3 shares)
# -> signed import over HTTP -> certify (2 admins) -> public results -> independent re-verification from the public data alone. Run from the repo root.
set -u; DB=evres; B=http://127.0.0.1:3059; W=/tmp/rescer; E=aaaaaaaa-0000-4000-8000-000000000002; O=cccccccc-0000-4000-8000-000000000011; O2=cccccccc-0000-4000-8000-000000000012
export STAFF_KEY=$(openssl rand -hex 32); F=0; EV="node packages/cli/ev.mjs"
ok() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (got '$2', want '$3')"; F=1; fi; }
dropdb --if-exists $DB 2>/dev/null; createdb $DB; rm -rf $W
for f in db/migrations/shared/*.sql; do psql -X -q -v ON_ERROR_STOP=1 $DB -f $f >/dev/null 2>&1 || { echo "migration $f failed"; exit 1; }; done
$EV keygen --out $W >/dev/null
HASH=$(cd server && node tools.mjs hash 'staff-pass-123'); S1=$(openssl rand -hex 20); S2=$(openssl rand -hex 20); S3=$(openssl rand -hex 20); S4=$(openssl rand -hex 20)
enc() { (cd server && node tools.mjs enc $1); }
psql -X -q -v h="$HASH" $DB << SQL
INSERT INTO org.organizations(id,slug,name) VALUES ('$O','resorg','Results Org'),('$O2','other','Other Org');
INSERT INTO election.elections(id,org_id,status,opens_at,closes_at) VALUES ('$E','$O','DRAFT',now()-interval '1h',now()+interval '1h');
INSERT INTO election.positions(id,election_id,title,seats,scope,sort) VALUES ('11111111-0000-4000-8000-000000000001','$E','President',1,'{"all":true}',1),('11111111-0000-4000-8000-000000000002','$E','Senators',2,'{"all":true}',2);
INSERT INTO election.candidates(election_id,position_id,name) SELECT '$E', '11111111-0000-4000-8000-000000000001', n FROM unnest(ARRAY['Ann','Ben','Cy']) n;
INSERT INTO election.candidates(election_id,position_id,name) SELECT '$E', '11111111-0000-4000-8000-000000000002', n FROM unnest(ARRAY['Xia','Yan','Zed']) n;
INSERT INTO election.voters(election_id,student_id,channel,attrs) SELECT '$E', 'V'||g, 'ONLINE', '{}' FROM generate_series(1,6) g;
INSERT INTO identity.vouchers SELECT id, hmac('V-'||student_id,'p','sha256'), now()+interval '1 day' FROM election.voters;
INSERT INTO admin.admins(org_id,name,username,role,password_hash,totp_secret) VALUES ('$O','Admin 1','a1','ADMIN',:'h','\\x$(enc $S1)'),('$O','Admin 2','a2','ADMIN',:'h','\\x$(enc $S2)'),('$O','Proctor','p1','PROCTOR',:'h','\\x$(enc $S3)'),('$O2','Outsider','o1','ADMIN',:'h','\\x$(enc $S4)');
SQL
export DATABASE_URL="postgresql://app_api:devpass@127.0.0.1/$DB" PEPPER=p REQUEST_KEY=r RECEIPT_KEY=c ELECTION_PUBKEY=$(cat $W/election.pub) PORT=3059 DEBUG_API=1
(cd server && exec node index.mjs >/tmp/res.log 2>&1) & PID=$!; sleep 2; trap 'kill $PID 2>/dev/null' EXIT
declare -A TK; jar() { rm -f /tmp/r_$1.jar; TK[$1]=$(curl -s -c /tmp/r_$1.jar $B/api/csrf | sed 's/.*"token":"\([^"]*\)".*/\1/'); }
c() { local a=$1 m=$2 p=$3 d=${4:-}; ST=$(curl -s -o /tmp/ro -w "%{http_code}" -b /tmp/r_$a.jar -c /tmp/r_$a.jar -H "X-CSRF-Token: ${TK[$a]}" -H 'Content-Type: application/json' -X $m $B$p ${d:+-d "$d"}); BODY=$(cat /tmp/ro); }
q() { psql -X -tA $DB -c "$1"; }; jget() { python3 -c "import json,sys;d=json.loads(sys.stdin.read());print($1)"; }
code_of() { echo "$BODY" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p'; }
for j in a1 a2 p1 o1 anon; do jar $j; done
login() { c $1 POST /api/staff/login "{\"username\":\"$2\",\"password\":\"staff-pass-123\"}"; c $1 POST /api/staff/mfa "{\"code\":\"$(cd server && node tools.mjs code $3)\"}"; }
login a1 a1 $S1; login a2 a2 $S2; login p1 p1 $S3; login o1 o1 $S4
R=/api/admin/elections/$E

# --- keys: both are registered before voting; the public info shows their fingerprints ---
c a1 POST $R/key "{\"publicKey\":\"$(cat $W/election.pub)\"}"; c a1 POST $R/signing-key "{\"publicKey\":\"$(cat $W/signing.pub)\"}"; K1=$ST
c a1 POST $R/signing-key '{"publicKey":"AAAA"}'; K2=$ST; c p1 POST $R/signing-key "{\"publicKey\":\"$(cat $W/signing.pub)\"}"; K3=$ST; c o1 POST $R/signing-key "{\"publicKey\":\"$(cat $W/signing.pub)\"}"; K4=$ST
ok "signing key: admin sets it; short key 400; proctor 403; other-org admin 403" "$K1 $K2 $K3 $K4" "200 400 403 403"
c anon GET /api/elections/$E/info
FPS=$(python3 -c "import base64,hashlib;print(hashlib.sha256(base64.b64decode(open('$W/signing.pub').read())).hexdigest()[:16])")
ok "public info shows the signing key fingerprint, equal to the ceremony key's" "$(echo "$BODY" | jget "d['signingKeyFingerprint']")" "$FPS"
c a1 GET $R/readiness; ok "readiness lists the signing key check as passed" "$(echo "$BODY" | jget "[x['ok'] for x in d['checks'] if x['name']=='signing_key_set'][0]")" "True"
q "UPDATE election.elections SET status='OPEN' WHERE id='$E'" >/dev/null     # lock/open approvals have their own tests (lifecycle); here we start from an open election

# --- five voters vote over HTTP (real registration, session, server-side sealing) ---
cast() { # voter-number, then president name or ABSTAIN, then senators (comma list) or ABSTAIN
  local n=$1 pres=$2 sen=$3; jar v$n
  c v$n POST /api/auth/register "{\"electionId\":\"$E\",\"studentId\":\"V$n\",\"voucher\":\"V-V$n\",\"password\":\"voter-pass-$n-xx\",\"termsAccepted\":true}"
  c v$n POST /api/auth/login "{\"electionId\":\"$E\",\"studentId\":\"V$n\",\"password\":\"voter-pass-$n-xx\"}"
  c v$n GET /api/elections/$E/ballot
  local sel=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin); pres='$pres'; sen='$sen'; out=[]
for c in d['contests']:
    want=pres if c['positionTitle']=='President' else sen
    if want=='ABSTAIN': out.append({'contestId':c['id'],'candidateIds':[],'abstain':True})
    else: ids=[k['id'] for k in c['candidates'] if k['name'] in want.split(',')]; out.append({'contestId':c['id'],'candidateIds':ids,'abstain':False})
print(json.dumps(out))")
  c v$n POST /api/elections/$E/ballot "{\"nonce\":\"$(python3 -c 'import uuid;print(uuid.uuid4())')\",\"round\":1,\"selections\":$sel}"
}
cast 1 Ann Xia,Yan; V1=$ST; cast 2 Ann Xia,Zed; V2=$ST; cast 3 Ben Yan,Zed; V3=$ST; cast 4 ABSTAIN Xia,Yan; V4=$ST; cast 5 Ben ABSTAIN; V5=$ST
ok "five ballots accepted" "$V1 $V2 $V3 $V4 $V5" "200 200 200 200 200"

# --- close with two admins ---
c a1 POST $R/actions '{"action":"close"}'; AP=$(echo "$BODY" | jget "d['approvalId']"); c a2 POST /api/admin/approvals/$AP/approve
ok "election closed by two admins" "$(q "select status from election.elections where id='$E'")" CLOSED
c anon GET /api/elections/$E/results
ok "public results before certification: only the status, no counts" "$(echo "$BODY" | jget "[d['published'], d['status'], 'contests' in d]")" "[False, 'CLOSED', False]"

# --- import refused while ballots are still unsealed (valid signature, so the database check is what answers) ---
psql -X -tA $DB -c "SELECT '{\"chain\":\"main\",\"ballots\":0,\"chainTip\":null,\"counts\":{}}'" | tr -d '\n' > /tmp/r_early.txt
SIGE=$(cd server && node tools.mjs sign $W/signing.key /tmp/r_early.txt)
imp() { local bodyfile=$1 sig=$2; local body=$(python3 -c "import json;print(json.dumps(open('$bodyfile').read()))"); c a1 POST $R/results "{\"results\":{\"body\":$body,\"signature\":\"$sig\"}}"; }
imp /tmp/r_early.txt $SIGE; ok "import with unsealed ballots in the inbox is refused" "$ST $(code_of)" "409 GATE_UNSEALED_BALLOTS"
psql -X -q $DB -c "CALL ballots.seal('$E','main',1,true)"
ok "five ballots sealed, inbox empty" "$(q "select count(*) from ballots.ballots where election_id='$E'") $(q "select count(*) from ballots.inbox")" "5 0"

# --- the real offline tally ---
export PGHOST=/var/run/postgresql PGUSER=${PGUSER:-$(id -un)}
$EV export-ballots --db "postgresql:///$DB" --election $E --out $W/export.json > /tmp/r_exp.txt 2>&1; ok "ev export-ballots" "$(grep -c '^OK exported 5 ballots' /tmp/r_exp.txt)" 1
$EV verify --ballots $W/export.json >/dev/null 2>&1; ok "ev verify accepts the export" "$?" 0
$EV tally --ballots $W/export.json --shares $W/share-1.txt,$W/share-3.txt,$W/share-5.txt --sign $W/signing.key --out $W/results.json >/dev/null 2>&1; ok "ev tally with 3 of 5 shares" "$?" 0
python3 - << PY
import json; r=json.load(open('$W/results.json')); b=json.loads(r['body'])
open('/tmp/r_body.txt','w').write(r['body']); open('/tmp/r_sig.txt','w').write(r['signature'])
def forge(name, fn):
    x=json.loads(r['body']); fn(x); open('/tmp/r_f_'+name+'.txt','w').write(json.dumps(x))
P='11111111-0000-4000-8000-000000000001'; S='11111111-0000-4000-8000-000000000002'
forge('fewer', lambda x: x.update(ballots=4)); forge('tip', lambda x: x.update(chainTip='00'*32)); forge('chain', lambda x: x.update(chain='lab-9'))
forge('contest', lambda x: x['counts'].update({'11111111-0000-4000-8000-0000000000ff': x['counts'][P]}))
forge('crosscand', lambda x: x['counts'][P]['candidates'].update({list(x['counts'][S]['candidates'])[0]: 1}))
forge('toomany', lambda x: x['counts'][P]['candidates'].update({k: 5 for k in x['counts'][P]['candidates']}))
forge('overseats', lambda x: x['counts'][S].update(abstain=0) or x['counts'][S]['candidates'].update({k: 5 for k in x['counts'][S]['candidates']}))
forge('negative', lambda x: x['counts'][P].update(abstain=-1)); forge('notnum', lambda x: x['counts'][P].update(abstain='1'))
PY
sign() { (cd server && node tools.mjs sign $1 $2); }
c a1 POST $R/results "{\"results\":{\"body\":\"{}\",\"signature\":\"AAAA\"}}"; M0=$ST
c anon POST $R/results "{\"results\":{\"body\":\"{}\",\"signature\":\"AAAA\"}}"; M1=$ST; c p1 POST $R/results "{\"results\":{\"body\":\"{}\",\"signature\":\"AAAA\"}}"; M2=$ST
ok "import: malformed request 400; not signed in 401; proctor 403" "$M0 $M1 $M2" "400 401 403"
BADSIG=$(python3 -c "import base64;b=bytearray(base64.b64decode(open('/tmp/r_sig.txt').read()));b[0]^=1;print(base64.b64encode(bytes(b)).decode())")
imp /tmp/r_body.txt $BADSIG; T1="$ST $(code_of)"
imp /tmp/r_f_fewer.txt "$(cat /tmp/r_sig.txt)"; T2="$ST $(code_of)"
(cd /tmp && rm -rf evil && node "$OLDPWD/packages/cli/ev.mjs" keygen --out /tmp/evil >/dev/null) ; imp /tmp/r_body.txt "$(sign /tmp/evil/signing.key /tmp/r_body.txt)"; T3="$ST $(code_of)"
ok "forged: a flipped signature bit, a changed body with the old signature, a signature from someone else's key: all refused" "$T1|$T2|$T3" "409 GATE_BAD_SIGNATURE|409 GATE_BAD_SIGNATURE|409 GATE_BAD_SIGNATURE"
chk_forge() { imp /tmp/r_f_$1.txt "$(sign $W/signing.key /tmp/r_f_$1.txt)"; echo "$ST $(code_of)"; }
ok "validly signed but wrong: ballot count, chain tip, other chain" "$(chk_forge fewer)|$(chk_forge tip)|$(chk_forge chain)" "409 GATE_RESULTS_MISMATCH|409 GATE_RESULTS_MISMATCH|409 GATE_RESULTS_MISMATCH"
ok "validly signed but impossible: unknown contest, candidate from another contest, more votes than voters, more names than seats, negative, not a number" \
  "$(chk_forge contest)|$(chk_forge crosscand)|$(chk_forge toomany)|$(chk_forge overseats)|$(chk_forge negative)|$(chk_forge notnum)" \
  "409 GATE_RESULTS_INVALID|409 GATE_RESULTS_INVALID|409 GATE_RESULTS_INVALID|409 GATE_RESULTS_INVALID|409 GATE_RESULTS_INVALID|409 GATE_RESULTS_INVALID"
ok "nothing was stored by any refused import" "$(q "select count(*) from election.result_sets") $(q "select status from election.elections where id='$E'")" "0 CLOSED"

# --- the genuine file ---
imp /tmp/r_body.txt "$(cat /tmp/r_sig.txt)"; ok "genuine signed tally imported" "$ST $(echo "$BODY" | jget "d['status']")" "200 TALLIED"
imp /tmp/r_body.txt "$(cat /tmp/r_sig.txt)"; ok "the same chain cannot be imported twice" "$ST $(code_of)" "409 GATE_ALREADY_IMPORTED"
ok "an imported result set cannot be changed or deleted, even by the database owner" "$(psql -X -q $DB -c "UPDATE election.result_sets SET ballots=9" 2>&1 | grep -c 'insert-only') $(psql -X -q $DB -c "DELETE FROM election.result_sets" 2>&1 | grep -c 'insert-only')" "1 1"
c a1 GET $R/results; ok "staff view: chain imported and matching, nothing blocks certification" "$(echo "$BODY" | jget "[d['status'], d['chains'][0]['chain'], d['chains'][0]['ballots'], d['chains'][0]['matches'], d['certifyBlocker'], d['participation']]")" "['TALLIED', 'main', 5, True, None, 5]"
c anon GET /api/elections/$E/results; ok "still not public while only tallied" "$(echo "$BODY" | jget "[d['published'], d['status']]")" "[False, 'TALLIED']"

# --- certification blockers (test-only: the session switches triggers off to clean up, which nothing in the product can do) ---
cert() { c a1 POST $R/actions '{"action":"certify"}'; echo "$ST $(code_of)"; }
q "INSERT INTO ballots.inbox(election_id,round,receipt,ciphertext) VALUES ('$E',1,'\\x00','\\x00')" >/dev/null; U1=$(cert); q "DELETE FROM ballots.inbox" >/dev/null
q "INSERT INTO ballots.ballots(id,election_id,round,chain_id,seq,receipt,ciphertext,prev_hash,entry_hash) VALUES ('99999999-0000-4000-8000-000000000001','$E',1,'lab-9',1,'\\x01','\\x02',digest('lab-9','sha256'),'\\x03')" >/dev/null; U2=$(cert)
psql -X -q $DB -c "SET session_replication_role = replica; DELETE FROM ballots.ballots WHERE chain_id='lab-9'" >/dev/null
q "INSERT INTO ballots.ballots(id,election_id,round,chain_id,seq,receipt,ciphertext,prev_hash,entry_hash) VALUES ('99999999-0000-4000-8000-000000000002','$E',1,'lab-9',1,'\\x01','\\x02',digest('lab-9','sha256'),ballots.entry_hash(digest('lab-9','sha256'),'lab-9','99999999-0000-4000-8000-000000000002','\\x02',1))" >/dev/null; U3=$(cert)
psql -X -q $DB -c "SET session_replication_role = replica; DELETE FROM ballots.ballots WHERE chain_id='lab-9'" >/dev/null
q "INSERT INTO participation.participation(election_id,round,voter_id,channel,hour_bucket,request_hash) SELECT '$E',1,id,'ONLINE',date_trunc('hour',now()),'\\x00' FROM election.voters WHERE student_id='V6'" >/dev/null; U4=$(cert)
psql -X -q $DB -c "SET session_replication_role = replica; DELETE FROM participation.participation WHERE voter_id=(SELECT id FROM election.voters WHERE student_id='V6')" >/dev/null
ok "certify blocked: unsealed ballot / broken chain / chain with no results / participation differs from ballots counted" "$U1|$U2|$U3|$U4" "409 GATE_UNSEALED_BALLOTS|409 GATE_CHAIN_BROKEN|409 GATE_RESULTS_MISSING|409 GATE_PARTICIPATION_MISMATCH"
ok "the blockers left nothing behind" "$(q "select count(*) from ballots.ballots where election_id='$E'") $(q "select count(*) from participation.participation where election_id='$E'") $(q "select count(*) from admin.approvals where action='certify' and executed_at is null") " "5 5 0 "
psql -X -q $DB -c "DELETE FROM admin.approvals WHERE action='certify'" >/dev/null 2>&1

# --- certify: two admins ---
c a1 POST $R/actions '{"action":"certify"}'; AP=$(echo "$BODY" | jget "d['approvalId']")
c a1 POST /api/admin/approvals/$AP/approve; C1="$ST $(code_of)"; c p1 POST /api/admin/approvals/$AP/approve; C2=$ST; c o1 POST /api/admin/approvals/$AP/approve; C3=$ST
ok "certify: the requester cannot approve their own request; proctor 403; other-org admin 403" "$C1|$C2|$C3" "409 SAME_ADMIN|403|403"
c anon GET /api/elections/$E/results; ok "still nothing public before the second admin approves" "$(echo "$BODY" | jget "d['published']")" "False"
c a2 POST /api/admin/approvals/$AP/approve; ok "second admin approves: certified" "$ST $(q "select status, certified_at is not null from election.elections where id='$E'")" "200 CERTIFIED|t"
ok "audit trail: import and certification recorded" "$(q "select count(*) filter (where action='RESULTS_IMPORTED'), count(*) filter (where action='CERTIFIED'), count(*) filter (where action='SIGNING_KEY_SET') from ops.audit" | tr '|' ' ')" "1 1 1"

# --- public results ---
c anon GET /api/elections/$E/results; echo "$BODY" > /tmp/r_public.json
ok "public: published, five ballots, certified" "$(jget "[d['published'], d['status'], d['ballots']]" < /tmp/r_public.json)" "[True, 'CERTIFIED', 5]"
ok "President: Ann 2, Ben 2, Cy 0, one abstention (a tie, shown as counts, not declared)" "$(jget "[(x['title'], [(k['name'],k['votes']) for k in x['candidates']], x['abstain']) for x in d['contests'] if x['title']=='President'][0]" < /tmp/r_public.json)" "('President', [('Ann', 2), ('Ben', 2), ('Cy', 0)], 1)"
ok "Senators: Xia 3, Yan 3, Zed 2, one abstention" "$(jget "[(x['title'], x['seats'], [(k['name'],k['votes']) for k in x['candidates']], x['abstain']) for x in d['contests'] if x['title']=='Senators'][0]" < /tmp/r_public.json)" "('Senators', 2, [('Xia', 3), ('Yan', 3), ('Zed', 2)], 1)"
ok "nothing identifying is published (no voter ids, receipts, nonces or emails)" "$(grep -c -i 'voter\|receipt\|nonce\|email\|student' /tmp/r_public.json)" 0
# independent verification: only the public response and the offline tool
python3 - << 'PY'
import json; d=json.load(open('/tmp/r_public.json')); s=d['sets'][0]
open('/tmp/r_pub_results.json','w').write(json.dumps({'body':s['body'],'signature':s['signature']})); open('/tmp/r_pub_key.txt','w').write(d['signingKey'])
PY
$EV verify-results --results /tmp/r_pub_results.json --pub /tmp/r_pub_key.txt >/dev/null 2>&1; ok "anyone can re-verify the published signed tally offline with ev verify-results" "$?" 0
python3 - << 'PY'
import json; r=json.load(open('/tmp/r_pub_results.json')); r['body']=r['body'].replace('"ballots":5','"ballots":6'); json.dump(r,open('/tmp/r_pub_tampered.json','w'))
PY
$EV verify-results --results /tmp/r_pub_tampered.json --pub /tmp/r_pub_key.txt >/dev/null 2>&1; ok "...and a tampered copy fails that check" "$?" 1
ok "the published counts equal the signed body's counts" "$(python3 -c "
import json; d=json.load(open('/tmp/r_public.json')); b=json.loads(d['sets'][0]['body'])['counts']
ok=all(b[c['id']]['abstain']==c['abstain'] and all(b[c['id']]['candidates'].get(k['id'],0)==k['votes'] for k in c['candidates']) for c in d['contests']); print(ok)")" "True"
c anon GET /api/elections/not-a-uuid/results; N1=$ST; c anon GET /api/elections/aaaaaaaa-0000-4000-8000-0000000000ff/results; N2=$ST
ok "public results: bad id 404, unknown election 404" "$N1 $N2" "404 404"
# --- frozen after certification ---
imp /tmp/r_body.txt "$(cat /tmp/r_sig.txt)"; X1="$ST $(code_of)"; c a1 POST $R/signing-key "{\"publicKey\":\"$(cat $W/signing.pub)\"}"; X2="$ST $(code_of)"
ok "after certification: no new import, no change of signing key" "$X1|$X2" "409 GATE_BAD_STATE|409 GATE_BAD_STATE"
DENIED=0; for t in election.result_sets; do PGPASSWORD=devpass psql -X -h 127.0.0.1 -U app_api $DB -c "select 1 from $t" 2>&1 | grep -q "permission denied" && DENIED=$((DENIED+1)); done
ok "app_api cannot read the result sets table directly" "$DENIED" 1
[ $F = 0 ] && echo "ALL RESULTS CHECKS PASS" || echo "SOME RESULTS CHECKS FAILED"
