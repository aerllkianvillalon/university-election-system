#!/usr/bin/env bash
# Support forms and claim codes over real HTTP: recording, no account side effects from public forms, staff queue, in-person claim, rate limits, privilege.
set -u; DB=evsup; B=http://127.0.0.1:3058; E=aaaaaaaa-0000-4000-8000-000000000001; O=cccccccc-0000-4000-8000-000000000001; O2=cccccccc-0000-4000-8000-000000000002
export STAFF_KEY=$(openssl rand -hex 32); F=0
ok() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (got '$2', want '$3')"; F=1; fi; }
dropdb --if-exists $DB 2>/dev/null; createdb $DB
for f in db/migrations/shared/*.sql; do psql -X -q -v ON_ERROR_STOP=1 $DB -f $f >/dev/null 2>&1 || { echo "migration $f failed"; exit 1; }; done
HASH=$(cd server && node tools.mjs hash 'staff-pass-123'); S1=$(openssl rand -hex 20); S2=$(openssl rand -hex 20); S3=$(openssl rand -hex 20)
EN1=$(cd server && node tools.mjs enc $S1); EN2=$(cd server && node tools.mjs enc $S2); EN3=$(cd server && node tools.mjs enc $S3)
psql -X -q -v h="$HASH" $DB << SQL
INSERT INTO org.organizations(id,slug,name) VALUES ('$O','suporg','Support Org'),('$O2','other','Other Org');
INSERT INTO election.elections(id,org_id,status,opens_at,closes_at) VALUES ('$E','$O','OPEN',now()-interval '1h',now()+interval '1h');
INSERT INTO election.voters(id,election_id,student_id,channel,attrs,roll_email) VALUES
 ('dddddddd-0000-4000-8000-000000000001','$E','S1','ONLINE','{}','s1@x.edu'),('dddddddd-0000-4000-8000-000000000002','$E','S2','ONLINE','{}','s2@x.edu'),
 ('dddddddd-0000-4000-8000-000000000003','$E','S3','LAB','{}',NULL);
INSERT INTO identity.vouchers SELECT id, hmac('V-'||student_id,'p','sha256'), now()+interval '1 day' FROM election.voters WHERE student_id='S1';
INSERT INTO admin.admins(org_id,name,username,role,password_hash,totp_secret) VALUES ('$O','Admin','a1','ADMIN',:'h','\\x$EN1'),('$O','Proctor','p1','PROCTOR',:'h','\\x$EN2'),('$O2','Outsider','o1','ADMIN',:'h','\\x$EN3');
SQL
node packages/cli/ev.mjs keygen --out /tmp/supcer >/dev/null
export DATABASE_URL="postgresql://app_api:devpass@127.0.0.1/$DB" PEPPER=p REQUEST_KEY=r RECEIPT_KEY=c ELECTION_PUBKEY=$(cat /tmp/supcer/election.pub) PORT=3058 DEBUG_API=1
(cd server && exec node index.mjs >/tmp/sup.log 2>&1) & PID=$!; sleep 2; trap 'kill $PID 2>/dev/null' EXIT
declare -A TK; jar() { rm -f /tmp/s_$1.jar; TK[$1]=$(curl -s -c /tmp/s_$1.jar $B/api/csrf | sed 's/.*"token":"\([^"]*\)".*/\1/'); }
c() { local a=$1 m=$2 p=$3 d=${4:-}; ST=$(curl -s -o /tmp/so -w "%{http_code}" -b /tmp/s_$a.jar -c /tmp/s_$a.jar -H "X-CSRF-Token: ${TK[$a]}" -H 'Content-Type: application/json' -X $m $B$p ${d:+-d "$d"}); BODY=$(cat /tmp/so); }
q() { psql -X -tA $DB -c "$1"; }
reset_limits() { q "TRUNCATE security.rate_limits" >/dev/null; }
jar v; jar a1; jar p1; jar o1
# a signed-in voter (S1) for the session_verified check
c v POST /api/auth/register "{\"electionId\":\"$E\",\"studentId\":\"S1\",\"voucher\":\"V-S1\",\"password\":\"old-password-1\",\"termsAccepted\":true}"; c v POST /api/auth/login "{\"electionId\":\"$E\",\"studentId\":\"S1\",\"password\":\"old-password-1\"}"
ok "S1 signed in" "$ST" 200

# --- recording ---
jar anon
c anon POST /api/support/protest "{\"electionId\":\"$E\",\"studentId\":\"S1\",\"subject\":\"Late posters\",\"details\":\"Posters were up after the deadline.\"}"
REF=$(echo "$BODY" | sed -n 's/.*"reference":"\([^"]*\)".*/\1/p')
ok "protest recorded: 202 and a reference like ABCD-EF23" "$ST $(echo $REF | grep -cE '^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$')" "202 1"
ok "anonymous filer is not marked session-verified; student is on the roll" "$(q "select session_verified, on_roll from support.requests where ref='$REF'")" "f|t"
c v POST /api/support/protest "{\"electionId\":\"$E\",\"studentId\":\"S1\",\"subject\":\"Second\",\"details\":\"Filed while signed in.\"}"
ok "signed-in S1 filing as S1 is marked session-verified" "$(q "select session_verified from support.requests where subject='Second'")" "t"
c v POST /api/support/protest "{\"electionId\":\"$E\",\"studentId\":\"S2\",\"subject\":\"Impersonation\",\"details\":\"Signed in as S1 but typed S2.\"}"
ok "signed in as S1 filing as S2 is NOT session-verified" "$(q "select session_verified from support.requests where subject='Impersonation'")" "f"
c anon POST /api/support/protest "{\"electionId\":\"$E\",\"studentId\":\"NOPE\",\"subject\":\"x\",\"details\":\"y\"}"
ok "unknown Student ID: same 202 answer (no roll leak), stored with on_roll false" "$ST $(echo $BODY | grep -c reference) $(q "select on_roll from support.requests where student_id='NOPE'")" "202 1 f"
c anon POST /api/support/report "{\"electionId\":\"$E\",\"url\":\"http://fake-ctu-vote.example\",\"details\":\"Got this by SMS\"}"
ok "report recorded without a Student ID" "$ST $(q "select kind, student_id is null from support.requests where url like 'http://fake%'")" "202 report|t"
# --- the dispute form must not change any account ---
c anon POST /api/support/dispute "{\"electionId\":\"$E\",\"studentId\":\"S1\",\"details\":\"Someone else registered as me.\"}"
ok "dispute recorded, and S1's account is NOT flagged by a public form" "$ST $(q "select disputed from identity.accounts a join election.voters v on v.id=a.voter_id where v.student_id='S1'")" "202 f"

# --- validation ---
reset_limits
c anon POST /api/support/protest "{\"electionId\":\"$E\",\"studentId\":\"S1\",\"details\":\"no subject\"}"; A=$ST
c anon POST /api/support/dispute "{\"electionId\":\"$E\",\"studentId\":\"S1\",\"details\":\"$(head -c 4001 /dev/zero | tr '\0' a)\"}"; Bv=$ST
c anon POST /api/support/report "{\"electionId\":\"not-a-uuid\",\"url\":\"u\"}"; C=$ST
c anon POST /api/support/report "{\"electionId\":\"aaaaaaaa-0000-4000-8000-0000000000ff\",\"url\":\"u\"}"; D=$ST
c anon POST /api/support/bogus "{\"electionId\":\"$E\"}"; G=$ST
c anon POST /api/support/protest "{\"electionId\":\"$E\",\"studentId\":\"   \",\"subject\":\"s\",\"details\":\"d\"}"; H=$ST
ok "validation: missing field, 4001-char text, bad uuid, unknown election, unknown kind, blank id" "$A $Bv $C $D $G $H" "400 400 400 400 404 400"
ok "nothing was stored by the rejected requests" "$(q "select count(*) from support.requests")" 6

# --- rate limits ---
reset_limits; for i in 1 2 3 4 5; do c anon POST /api/support/protest "{\"electionId\":\"$E\",\"studentId\":\"RL\",\"subject\":\"s$i\",\"details\":\"d\"}"; done; L5=$ST
c anon POST /api/support/protest "{\"electionId\":\"$E\",\"studentId\":\"RL\",\"subject\":\"s6\",\"details\":\"d\"}"
ok "5 filings a day per Student ID, the 6th is refused" "$L5 $ST" "202 429"
reset_limits; for i in $(seq 1 10); do c anon POST /api/support/report "{\"electionId\":\"$E\",\"url\":\"u$i\"}"; done; c anon POST /api/support/report "{\"electionId\":\"$E\",\"url\":\"u11\"}"
ok "10 filings an hour per IP, the 11th is refused" "$ST" 429
reset_limits

# --- claim with nothing issued: one generic answer ---
c anon POST /api/support/claim "{\"electionId\":\"$E\",\"studentId\":\"S1\",\"claimCode\":\"AAAAA-BBBBB\",\"password\":\"new-password-1\"}"; N1="$ST $BODY"
c anon POST /api/support/claim "{\"electionId\":\"$E\",\"studentId\":\"ZZZ\",\"claimCode\":\"AAAAA-BBBBB\",\"password\":\"new-password-1\"}"
ok "claim with no code issued: 400 and the same body for a real and a fake Student ID" "$N1" "$ST $BODY"

# --- staff ---
login() { c $1 POST /api/staff/login "{\"username\":\"$2\",\"password\":\"staff-pass-123\"}"; c $1 POST /api/staff/mfa "{\"code\":\"$(cd server && node tools.mjs code $3)\"}"; }
login a1 a1 $S1; login p1 p1 $S2; login o1 o1 $S3
c p1 GET /api/admin/elections/$E/support; PS=$ST
c o1 GET /api/admin/elections/$E/support; OS=$ST
c a1 GET /api/admin/elections/$E/support; AS=$ST
ok "support queue: admin 200, proctor 403, other organization's admin refused" "$AS $PS $OS" "200 403 403"
ok "queue shows the filed requests newest first, with the roll flag" "$(echo "$BODY" | python3 -c "import json,sys;r=json.load(sys.stdin)['requests'];print(len(r), r[0]['kind'], any(x['student_id']=='NOPE' and x['on_roll']==False for x in r))")" "21 report True"
c a1 GET "/api/admin/elections/$E/support?kind=dispute&status=NEW"
ID=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin)['requests'][0]['id'])")
c a1 POST /api/admin/support/$ID/status '{"status":"IN_REVIEW","note":"Called the registrar"}'; U1=$ST
c a1 POST /api/admin/support/$ID/status '{"status":"BOGUS"}'; U2=$ST
c o1 POST /api/admin/support/$ID/status '{"status":"RESOLVED"}'; U3=$ST
c p1 POST /api/admin/support/$ID/status '{"status":"RESOLVED"}'; U4=$ST
ok "status update: admin ok; bad status 400; other-org admin 403; proctor 403" "$U1 $U2 $U3 $U4" "200 400 403 403"
ok "the note and status were stored; the refused updates changed nothing" "$(q "select status||'/'||note from support.requests where id='$ID'")" "IN_REVIEW/Called the registrar"

# --- claim codes ---
c a1 POST /api/admin/elections/$E/claim-codes '{"studentId":"S1"}'; CODE=$(echo "$BODY" | sed -n 's/.*"claimCode":"\([^"]*\)".*/\1/p')
ok "admin issues a claim code for S1 (shown once, grouped)" "$ST $(echo $CODE | grep -cE '^[0-9A-F]{5}-[0-9A-F]{5}$')" "200 1"
ok "only a hash is stored (the code is nowhere in the database)" "$(q "select count(*) from identity.claim_codes where encode(code_hash,'escape') like '%${CODE//-/}%'")" 0
ok "issuing flags the account as disputed" "$(q "select disputed from identity.accounts a join election.voters v on v.id=a.voter_id where v.student_id='S1'")" "t"
BEFORE=$(q "select count(*) from ops.outbox"); c anon POST /api/auth/forgot "{\"electionId\":\"$E\",\"studentId\":\"S1\"}"
ok "while disputed, a password reset for S1 is not even queued" "$(q "select count(*) from ops.outbox")" "$BEFORE"
c a1 POST /api/admin/elections/$E/claim-codes '{"studentId":"S3"}'; X1=$ST; c a1 POST /api/admin/elections/$E/claim-codes '{"studentId":"NOBODY"}'; X2=$ST; c o1 POST /api/admin/elections/$E/claim-codes '{"studentId":"S1"}'; X3=$ST; c p1 POST /api/admin/elections/$E/claim-codes '{"studentId":"S1"}'; X4=$ST
ok "no code for a lab-channel voter or an unknown ID (409); other-org admin and proctor refused (403)" "$X1 $X2 $X3 $X4" "409 409 403 403"
claim() { c anon POST /api/support/claim "{\"electionId\":\"$E\",\"studentId\":\"$1\",\"claimCode\":\"$2\",\"password\":\"$3\"}"; }
claim S1 "AAAAA-BBBBB" "new-password-1"; W1=$ST; claim S2 "$CODE" "new-password-1"; W2=$ST; claim S1 "$CODE" "short"; W3=$ST
ok "claim refused: wrong code, right code for another student, password under 8 characters" "$W1 $W2 $W3" "400 400 400"
ok "refused claims changed nothing (code unused, still disputed)" "$(q "select c.used_at is null from identity.claim_codes c join election.voters v on v.id=c.voter_id where v.student_id='S1'") $(q "select disputed from identity.accounts a join election.voters v on v.id=a.voter_id where v.student_id='S1'")" "t t"
c v GET /api/me; ME_BEFORE=$ST
claim S1 "${CODE,,}" "new-password-1"; W4=$ST
ok "claim works (code typed lower case): 200" "$ST" 200
ok "claim cleared the dispute, used the code, ended old sessions" "$(q "select disputed from identity.accounts a join election.voters v on v.id=a.voter_id where v.student_id='S1'") $(q "select count(*) from identity.sessions s join election.voters v on v.id=s.voter_id where v.student_id='S1'") $(q "select used_at is not null from identity.claim_codes c join election.voters v on v.id=c.voter_id where v.student_id='S1'")" "f 0 t"
c v GET /api/me; ME_AFTER=$ST
ok "the old signed-in browser lost its session" "$ME_BEFORE $ME_AFTER" "200 401"
jar n1; c n1 POST /api/auth/login "{\"electionId\":\"$E\",\"studentId\":\"S1\",\"password\":\"old-password-1\"}"; P1=$ST
c n1 POST /api/auth/login "{\"electionId\":\"$E\",\"studentId\":\"S1\",\"password\":\"new-password-1\"}"; P2=$ST
ok "old password refused, new password works" "$P1 $P2" "401 200"
claim S1 "$CODE" "another-password-1"
ok "a used code cannot be used again" "$ST" 400
# a voter who never registered gets an account through the claim
c a1 POST /api/admin/elections/$E/claim-codes '{"studentId":"S2"}'; C2=$(echo "$BODY" | sed -n 's/.*"claimCode":"\([^"]*\)".*/\1/p'); claim S2 "$C2" "s2-password-1"
c n1 POST /api/auth/login "{\"electionId\":\"$E\",\"studentId\":\"S2\",\"password\":\"s2-password-1\"}"
ok "a voter with no account can claim one and sign in" "$ST $(q "select count(*) from identity.accounts a join election.voters v on v.id=a.voter_id where v.student_id='S2'")" "200 1"
# expiry and brute force
c a1 POST /api/admin/elections/$E/claim-codes '{"studentId":"S1"}'; C3=$(echo "$BODY" | sed -n 's/.*"claimCode":"\([^"]*\)".*/\1/p'); q "update identity.claim_codes set expires_at=now()-interval '1 minute'" >/dev/null
claim S1 "$C3" "x-password-123"
ok "an expired code is refused" "$ST" 400
for i in 1 2 3 4; do claim S1 "WRONG-CODE$i" "x-password-123"; done; claim S1 "$C3" "x-password-123"
ok "6th attempt on one Student ID in an hour is rate limited (even with a code that would have worked)" "$ST" 429
c a1 POST /api/admin/elections/$E/claim-codes '{"studentId":"S1"}'; C4=$(echo "$BODY" | sed -n 's/.*"claimCode":"\([^"]*\)".*/\1/p'); claim S1 "$C4" "final-password-1"
ok "staff issuing a fresh code ends the lockout, and the claim then works" "$ST" 200
# --- audit and privilege ---
ok "audit: 4 codes issued, 3 redeemed, 1 status change" "$(q "select count(*) filter (where action='CLAIM_CODE_ISSUED'), count(*) filter (where action='CLAIM_REDEEMED'), count(*) filter (where action='SUPPORT_IN_REVIEW') from ops.audit" | tr '|' ' ')" "4 3 1"
DENIED=0; for t in support.requests identity.claim_codes; do PGPASSWORD=devpass psql -X -h 127.0.0.1 -U app_api $DB -c "select 1 from $t" 2>&1 | grep -q "permission denied" && DENIED=$((DENIED+1)); done
ok "app_api cannot read the support or claim-code tables" "$DENIED" 2
# --- robustness: an unexpected database error is a 500, and the API keeps serving ---
psql -X -q $DB -c "REVOKE SELECT ON identity.sessions FROM app_api" >/dev/null
c n1 GET /api/me; R1=$ST; BODY1="$BODY"
psql -X -q $DB -c "GRANT SELECT ON identity.sessions TO app_api" >/dev/null
c n1 GET /api/me; R2=$ST
ok "database error on a route with no try/catch: 500 with no internals, then the server still answers" "$R1 $(echo "$BODY1" | grep -c 'permission') $R2" "500 0 200"
c anon POST /api/support/report '{"electionId": broken json';
ok "malformed JSON body is a 400, not a crash" "$ST" 400
[ $F = 0 ] && echo "ALL SUPPORT CHECKS PASS" || echo "SOME SUPPORT CHECKS FAILED"
