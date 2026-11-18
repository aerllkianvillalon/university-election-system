#!/usr/bin/env bash
# Staff account lifecycle, end to end over HTTP: first admins via the setup tool, setup with a one-time code, password and authenticator changes,
# recovery codes, inviting / disabling / re-inviting under the two-person rule, and that no secret is ever stored in the clear.
set -u; DB=evacc; B=http://127.0.0.1:3061; export STAFF_KEY=$(openssl rand -hex 32); F=0; export PGHOST=/var/run/postgresql PGUSER=${PGUSER:-$(id -un)}
ok() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (got '$2', want '$3')"; F=1; fi; }
dropdb --if-exists $DB 2>/dev/null; createdb $DB
for f in db/migrations/shared/*.sql; do psql -X -q -v ON_ERROR_STOP=1 $DB -f $f >/dev/null 2>&1 || { echo "migration $f failed"; exit 1; }; done
export DATABASE_URL="postgresql:///$DB" PEPPER=p; CLI="node server/staff-admin.mjs"
export REQUEST_KEY=r RECEIPT_KEY=c ELECTION_PUBKEY=$(openssl rand -base64 32) PORT=3061 DEBUG_API=1
DB_API="postgresql://app_api:devpass@127.0.0.1/$DB"
q() { psql -X -tA $DB -c "$1"; }; jget() { python3 -c "import json,sys;d=json.loads(sys.stdin.read());print($1)"; }
codeof() { sed -n 's/.*Setup code for [^:]*: \([A-Z0-9-]*\).*/\1/p'; }
# an independent TOTP implementation (RFC 6238, SHA-1, 6 digits, 30 s), so the test does not rely on the server's own
totp() { python3 -c "
import sys,hmac,hashlib,base64,struct,time
s=sys.argv[1]; off=int(sys.argv[2]); key=base64.b32decode(s+'='*((8-len(s)%8)%8)); st=int(time.time()//30)+off
h=hmac.new(key,struct.pack('>Q',st),hashlib.sha1).digest(); o=h[19]&15
print('%06d'%((struct.unpack('>I',h[o:o+4])[0]&0x7fffffff)%1000000))" "$1" "$2"; }

# ---- the setup tool appoints the first administrators ----
ok "create-org" "$($CLI create-org --name 'Acc Org' --slug accorg 2>&1 | grep -c '^OK')" 1
C1=$($CLI invite --org accorg --username nn1 --name 'Nora One' --role ADMIN | codeof); C2=$($CLI invite --org accorg --username nn2 --name 'Nico Two' --role ADMIN | codeof); C3=$($CLI invite --org accorg --username nn3 --name 'Nia Three' --role ADMIN | codeof)
ok "invite prints a one-time setup code in groups of four" "$(echo "$C1" | grep -cE '^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$')" 1
ok "the tool refuses a bad role, a bad username and a taken username" "$($CLI invite --org accorg --username x1 --name X --role KING 2>&1 | grep -c refused) $($CLI invite --org accorg --username 'Bad Name' --name X --role ADMIN 2>&1 | grep -c refused) $($CLI invite --org accorg --username nn1 --name X --role ADMIN 2>&1 | grep -c refused)" "1 1 1"
ok "invited accounts have no password and no authenticator yet" "$(q "select status, password_hash is null, totp_secret is null from admin.admins where username='nn1'")" "INVITED|t|t"
(cd server && exec node index.mjs >/tmp/acc.log 2>&1) & PID=$!; sleep 2; trap 'kill $PID 2>/dev/null' EXIT; export DATABASE_URL="$DB_API"
declare -A TK; jar() { rm -f /tmp/u_$1.jar; TK[$1]=$(curl -s -c /tmp/u_$1.jar $B/api/csrf | sed 's/.*"token":"\([^"]*\)".*/\1/'); }
c() { local a=$1 m=$2 p=$3 d=${4:-}; ST=$(curl -s -o /tmp/uo -w "%{http_code}" -b /tmp/u_$a.jar -c /tmp/u_$a.jar -H "X-CSRF-Token: ${TK[$a]}" -H 'Content-Type: application/json' -X $m $B$p ${d:+-d "$d"}); BODY=$(cat /tmp/uo); }
code_of() { echo "$BODY" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p'; }
PW=correct-horse-battery
relax() { q "delete from security.rate_limits where key like 'staff:%' or key like 'acct:%'" >/dev/null; }   # test shortcut: the sign-in limiter (5 per 15 min per username) is exercised elsewhere; this test signs in far more often
login() { relax; jar $1; c $1 POST /api/staff/login "{\"username\":\"$1\",\"password\":\"${2:-$PW}\"}"; [ "$ST" = 200 ] || return 1; c $1 POST /api/staff/mfa "{\"code\":\"$(totp "$(cat /tmp/sec_${3:-$1})" ${4:-1})\"}"; }
unlock() { q "update admin.admins set totp_last_step=0 where username='$1'" >/dev/null; }   # test shortcut: forget the replay counter (replay itself is tested once, for real)
setup() { # username code -> secret in /tmp/sec_$1, recovery codes in /tmp/rec_$1
  jar s_$1; c s_$1 POST /api/staff/setup/start "{\"username\":\"$1\",\"setupCode\":\"$2\"}"; [ "$ST" = 200 ] || { echo "setup start failed $ST"; return 1; }
  echo "$BODY" | jget "d['secret']" > /tmp/sec_$1; c s_$1 POST /api/staff/setup/finish "{\"username\":\"$1\",\"setupCode\":\"$2\",\"password\":\"$PW\",\"code\":\"$(totp "$(cat /tmp/sec_$1)" 0)\"}"
  echo "$BODY" | jget "' '.join(d['recoveryCodes'])" > /tmp/rec_$1; }

# ---- setup with the one-time code ----
jar s0; c s0 POST /api/staff/login "{\"username\":\"nn1\",\"password\":\"anything-at-all-123\"}"; ok "an invited account cannot sign in" "$ST" 401
c s0 POST /api/staff/setup/start "{\"username\":\"nn1\",\"setupCode\":\"AAAA-BBBB-CCCC\"}"; W1="$ST $BODY"; c s0 POST /api/staff/setup/start "{\"username\":\"nobody\",\"setupCode\":\"$C1\"}"; W2="$ST $BODY"
ok "setup start: a wrong code and an unknown username get the same refusal" "$W1" "$W2"
c s0 POST /api/staff/setup/start "{\"username\":\"nn1\",\"setupCode\":\"$(echo $C1 | tr 'A-Z' 'a-z')\"}"; S1=$ST; echo "$BODY" | jget "d['secret']" > /tmp/sec_nn1
ok "the code works typed in lower case; it returns a base32 secret and an otpauth address for this username" "$S1 $(wc -c < /tmp/sec_nn1 | tr -d ' ') $(echo "$BODY" | jget "d['uri'].startswith('otpauth://totp/CTU%20Vote:nn1?secret=') and d['name']=='Nora One' and d['role']=='ADMIN'")" "200 33 True"
c s0 POST /api/staff/setup/finish "{\"username\":\"nn1\",\"setupCode\":\"$C1\",\"password\":\"short\",\"code\":\"$(totp "$(cat /tmp/sec_nn1)" 0)\"}"; F1="$ST $(code_of)"
c s0 POST /api/staff/setup/finish "{\"username\":\"nn1\",\"setupCode\":\"$C1\",\"password\":\"$PW\",\"code\":\"000000\"}"; F2=$ST
ok "finish refused: password under 12 characters, wrong authenticator code" "$F1|$F2" "400 PASSWORD_TOO_SHORT|400"
ok "nothing changed after the refusals" "$(q "select status from admin.admins where username='nn1'")" INVITED
c s0 POST /api/staff/setup/finish "{\"username\":\"nn1\",\"setupCode\":\"$C1\",\"password\":\"$PW\",\"code\":\"$(totp "$(cat /tmp/sec_nn1)" 0)\"}"; echo "$BODY" | jget "' '.join(d['recoveryCodes'])" > /tmp/rec_nn1
ok "finish: 200 and ten recovery codes" "$ST $(wc -w < /tmp/rec_nn1 | tr -d ' ') $(tr ' ' '\n' < /tmp/rec_nn1 | grep -cE '^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$')" "200 10 10"
ok "the account is active with a password and a sealed authenticator; the setup code is used up" "$(q "select a.status, a.password_hash like '\$argon2%', a.totp_secret is not null, a.pending_totp is null, c.used_at is not null from admin.admins a join admin.setup_codes c on c.admin_id=a.id where a.username='nn1'")" "ACTIVE|t|t|t|t"
c s0 POST /api/staff/setup/start "{\"username\":\"nn1\",\"setupCode\":\"$C1\"}"; R1=$ST; c s0 POST /api/staff/setup/finish "{\"username\":\"nn1\",\"setupCode\":\"$C1\",\"password\":\"$PW\",\"code\":\"$(totp "$(cat /tmp/sec_nn1)" 0)\"}"; R2=$ST
ok "a used setup code cannot be used again" "$R1 $R2" "400 400"
ok "no secret is stored in the clear: setup code, recovery codes, password, authenticator secret are nowhere in a dump of the data" "$(pg_dump --data-only $DB 2>/dev/null | grep -c -F -e "$C1" -e "$(cat /tmp/rec_nn1 | cut -d' ' -f1)" -e "$PW" -e "$(cat /tmp/sec_nn1)")" 0
q "update admin.setup_codes set expires_at = now() - interval '1 minute' where admin_id=(select id from admin.admins where username='nn3')" >/dev/null; c s0 POST /api/staff/setup/start "{\"username\":\"nn3\",\"setupCode\":\"$C3\"}"
ok "an expired setup code is refused" "$ST" 400
for i in 1 2 3 4 5 6 7 8 9; do c s0 POST /api/staff/setup/start "{\"username\":\"nn3\",\"setupCode\":\"WRONG-CODE-$i\"}"; done; c s0 POST /api/staff/setup/start "{\"username\":\"nn3\",\"setupCode\":\"$C3\"}"
ok "the 11th attempt on one username in 15 minutes is rate limited, even with the right code" "$ST" 429

# ---- signing in after setup; replay protection is real ----
login nn1 >/dev/null; c nn1 GET /api/staff/me
ok "nn1 signs in with the authenticator code and /me names the account" "$ST $(echo "$BODY" | jget "[d['username'], d['role'], d['recoveryCodesLeft'], d['recovered']]")" "200 ['nn1', 'ADMIN', 10, False]"
jar r1; c r1 POST /api/staff/login "{\"username\":\"nn1\",\"password\":\"$PW\"}"; c r1 POST /api/staff/mfa "{\"code\":\"$(totp "$(cat /tmp/sec_nn1)" 1)\"}"
ok "the same authenticator code cannot be used twice (replay refused)" "$ST" 401
C2b=$C2; setup nn2 "$C2b" || true; unlock nn2; login nn2 >/dev/null; c nn2 GET /api/staff/me; ok "nn2 completes setup and signs in" "$ST" 200

# ---- your own account ----
c nn1 POST /api/staff/password "{\"current\":\"wrong-password-xx\",\"next\":\"a-brand-new-password\"}"; P1="$ST $(code_of)"
c nn1 POST /api/staff/password "{\"current\":\"$PW\",\"next\":\"short\"}"; P2="$ST $(code_of)"; c nn1 POST /api/staff/password "{\"current\":\"$PW\",\"next\":\"$PW\"}"; P3="$ST $(code_of)"
ok "password change refused: wrong current password, too short, unchanged" "$P1|$P2|$P3" "400 WRONG_PASSWORD|400 PASSWORD_TOO_SHORT|400 PASSWORD_UNCHANGED"
q "insert into admin.staff_sessions(id_hash, staff_id, mfa_verified, expires_at) select '\\x01', id, true, now()+interval '5 minutes' from admin.admins where username='nn1'" >/dev/null
c nn1 POST /api/staff/password "{\"current\":\"$PW\",\"next\":\"a-brand-new-password\"}"; P4=$ST
ok "password changed; every OTHER session of that person is ended, this one stays" "$P4 $(q "select count(*) from admin.staff_sessions s join admin.admins a on a.id=s.staff_id where a.username='nn1'") $(c nn1 GET /api/staff/me; echo $ST)" "200 1 200"
unlock nn1; ok "the old password no longer signs in" "$(login nn1 $PW >/dev/null; echo $ST)" 401
unlock nn1; PW2=a-brand-new-password; login nn1 $PW2 >/dev/null; c nn1 GET /api/staff/me; ok "the new password does" "$ST" 200
# authenticator replacement
c nn1 POST /api/staff/authenticator/start "{\"password\":\"nope\"}"; A0=$ST
c nn1 POST /api/staff/authenticator/start "{\"password\":\"$PW2\"}"; A1=$ST; echo "$BODY" | jget "d['secret']" > /tmp/sec_new; ok "authenticator replacement needs the password, then gives a new secret" "$A0 $A1" "400 200"
ok "the old authenticator still works until the new one proves itself" "$(q "select totp_secret is not null and pending_totp is not null from admin.admins where username='nn1'")" t
unlock nn1; c nn1 POST /api/staff/authenticator/confirm '{"code":"000000"}'; A2=$ST
q "insert into admin.staff_sessions(id_hash, staff_id, mfa_verified, expires_at) select '\\x02', id, true, now()+interval '5 minutes' from admin.admins where username='nn1'" >/dev/null
c nn1 POST /api/staff/authenticator/confirm "{\"code\":\"$(totp "$(cat /tmp/sec_new)" 0)\"}"; A3=$ST
ok "confirm: a wrong code is refused; the right code from the NEW secret switches over and ends other sessions" "$A2 $A3 $(q "select count(*) from admin.staff_sessions s join admin.admins a on a.id=s.staff_id where a.username='nn1'") $(q "select pending_totp is null from admin.admins where username='nn1'")" "400 200 1 t"
unlock nn1; ok "the old authenticator no longer works" "$(login nn1 $PW2 nn1 1 >/dev/null; echo $ST)" 401
unlock nn1; cp /tmp/sec_new /tmp/sec_nn1; login nn1 $PW2 >/dev/null; c nn1 GET /api/staff/me; ok "the new one does" "$ST" 200
# recovery codes
c nn1 POST /api/staff/recovery-codes "{\"password\":\"nope\"}"; V0=$ST; c nn1 POST /api/staff/recovery-codes "{\"password\":\"$PW2\"}"; V1=$ST; echo "$BODY" | jget "' '.join(d['recoveryCodes'])" > /tmp/rec_new
ok "new recovery codes need the password; ten come back once" "$V0 $V1 $(wc -w < /tmp/rec_new | tr -d ' ')" "400 200 10"
OLDREC=$(cut -d' ' -f1 /tmp/rec_nn1); NEWREC=$(cut -d' ' -f1 /tmp/rec_new); NEWREC2=$(cut -d' ' -f2 /tmp/rec_new)
rec_login() { relax; jar $1; c $1 POST /api/staff/login "{\"username\":\"nn1\",\"password\":\"$PW2\"}"; c $1 POST /api/staff/mfa "{\"recoveryCode\":\"$2\"}"; }
rec_login k1 "$OLDREC"; ok "an old recovery code stopped working when the set was replaced" "$ST" 401
rec_login k2 "$(echo $NEWREC | tr 'A-Z' 'a-z')"; K2=$ST; c k2 GET /api/staff/me
ok "a recovery code signs in (typed lower case), /me says it was a recovery sign-in and counts nine left" "$K2 $(echo "$BODY" | jget "[d['recovered'], d['recoveryCodesLeft']]")" "200 [True, 9]"
rec_login k3 "$NEWREC"; ok "a recovery code works only once" "$ST" 401
relax; c k2 POST /api/staff/authenticator/start "{\"password\":\"$PW2\"}"; echo "$BODY" | jget "d['secret']" > /tmp/sec_rec; q "update admin.admins set totp_last_step=0 where username='nn1'" >/dev/null
c k2 POST /api/staff/authenticator/confirm "{\"code\":\"$(totp "$(cat /tmp/sec_rec)" 0)\"}"; c k2 GET /api/staff/me
ok "replacing the authenticator clears the recovery-sign-in warning" "$ST $(echo "$BODY" | jget "d['recovered']")" "200 False"; cp /tmp/sec_rec /tmp/sec_nn1
relax; jar k4; c k4 POST /api/staff/login "{\"username\":\"nn1\",\"password\":\"$PW2\"}"; for i in 1 2 3 4 5; do c k4 POST /api/staff/mfa "{\"recoveryCode\":\"WRONG-0000$i\"}"; done; c k4 POST /api/staff/mfa "{\"recoveryCode\":\"$NEWREC2\"}"
ok "guessing recovery codes is rate limited per session (6th attempt, even with a valid code)" "$ST" 429

# ---- people and the two-person rule ----
jar anon; c anon GET /api/admin/staff; ok "the people list needs a session" "$ST" 401
unlock nn1; login nn1 $PW2 >/dev/null
c nn1 POST /api/admin/staff/invite '{"name":"Pat Proctor","username":"pat","role":"PROCTOR"}'; PC=$(echo "$BODY" | jget "d.get('setupCode','')")
ok "inviting a proctor takes one administrator: done at once, with a setup code" "$ST $(echo "$BODY" | jget "d['pending']") $(echo $PC | grep -cE '^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$')" "200 False 1"
c nn1 POST /api/admin/staff/invite '{"name":"Dup","username":"pat","role":"PROCTOR"}'; D1="$ST $(code_of)"; c nn1 POST /api/admin/staff/invite '{"name":"Bad","username":"Bad Name","role":"PROCTOR"}'; D2="$ST $(code_of)"; c nn1 POST /api/admin/staff/invite '{"name":"x"}'; D3=$ST
ok "invite refused: username taken, malformed username, missing fields" "$D1|$D2|$D3" "409 GATE_USERNAME_TAKEN|409 GATE_BAD_DETAILS|400"
c nn1 POST /api/admin/staff/invite '{"name":"Dee Four","username":"nn4","role":"ADMIN"}'; RQ=$(echo "$BODY" | jget "d.get('id','')")
ok "inviting an ADMIN only asks: pending, no setup code, no account yet" "$ST $(echo "$BODY" | jget "[d['pending'], 'setupCode' in d]") $(q "select count(*) from admin.admins where username='nn4'")" "200 [True, False] 0"
c nn1 GET /api/admin/staff; M1=$(echo "$BODY" | jget "[(p['action'], p['target'], p['initiator'], p['mine']) for p in d['pending']]"); c nn2 GET /api/admin/staff; M2=$(echo "$BODY" | jget "[p['mine'] for p in d['pending']]")
ok "the queue shows who asked; 'mine' is true for the requester only" "$M1 $M2" "[('invite', 'Dee Four', 'Nora One', True)] [False]"
c nn1 POST /api/admin/staff-requests/$RQ/approve; ok "the requester cannot approve their own request" "$ST $(code_of)" "409 SAME_ADMIN"
c pat GET /api/admin/staff 2>/dev/null; jar pat; setup pat "$PC" >/dev/null; unlock pat; login pat >/dev/null; c pat GET /api/admin/staff; c pat POST /api/admin/staff-requests/$RQ/approve; PA=$ST
ok "a proctor can set up and sign in but is refused the people list and approvals" "$(c pat GET /api/admin/staff; echo $ST) $PA" "403 403"
unlock nn2; login nn2 >/dev/null; c nn2 POST /api/admin/staff-requests/$RQ/approve; N4C=$(echo "$BODY" | jget "d.get('setupCode','')"); AP="$ST $(echo "$BODY" | jget "[d['action'], d['username']]")"
ok "the other administrator approves: the account is created and THEY are shown the setup code" "$AP $(echo $N4C | grep -cE '^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$')" "200 ['invite', 'nn4'] 1"
ok "nn4 exists as an invited ADMIN, invited by nn1's request; the request is closed" "$(q "select status, role from admin.admins where username='nn4'") $(q "select count(*) from admin.staff_requests where executed_at is not null")" "INVITED|ADMIN 1"
c nn1 POST /api/admin/staff/invite '{"name":"Eve Five","username":"nn5","role":"ADMIN"}'; RQ2=$(echo "$BODY" | jget "d['id']"); c nn2 POST /api/admin/staff-requests/$RQ2/cancel; X1=$ST; c nn2 POST /api/admin/staff-requests/$RQ2/approve; X2="$ST $(code_of)"; c pat POST /api/admin/staff-requests/$RQ2/cancel
ok "a declined request is gone and can no longer be approved; a proctor cannot cancel" "$X1 $X2 $ST $(q "select count(*) from admin.admins where username='nn5'")" "200 409 NOT_FOUND 403 0"
setup nn4 "$N4C" >/dev/null; c nn1 POST /api/admin/staff/invite '{"name":"Eve Five","username":"nn5","role":"ADMIN"}'; RQ3=$(echo "$BODY" | jget "d['id']"); unlock nn2; login nn2 >/dev/null; c nn2 POST /api/admin/staff-requests/$RQ3/approve; N5C=$(echo "$BODY" | jget "d['setupCode']"); setup nn5 "$N5C" >/dev/null
ok "four administrators are active after nn4 and nn5 complete setup" "$(q "select count(*) from admin.admins where org_id=(select org_id from admin.admins where username='nn1') and role='ADMIN' and status='ACTIVE'")" 4

# ---- disabling and re-inviting ----
unlock pat; login pat >/dev/null; c pat GET /api/staff/me; PS=$ST; unlock nn1; login nn1 $PW2 >/dev/null; PID1=$(q "select id from admin.admins where username='pat'")
c nn1 POST /api/admin/staff/$PID1/disable; DS="$ST $(echo "$BODY" | jget "[d['pending'], d['action']]")"; c pat GET /api/staff/me; PS2=$ST; unlock pat; PL=$(login pat >/dev/null 2>&1; echo $ST)
ok "disabling a proctor takes one administrator: their open session dies at once and they cannot sign in again" "$PS $DS $PS2 $PL" "200 200 [False, 'disable'] 401 401"
ok "the disabled account's setup state and sessions are gone" "$(q "select status from admin.admins where username='pat'") $(q "select count(*) from admin.staff_sessions where staff_id='$PID1'")" "DISABLED 0"
c nn1 POST /api/admin/staff/$(q "select id from admin.admins where username='nn1'")/disable; ok "you cannot disable yourself" "$ST $(code_of)" "409 GATE_SELF"
N5ID=$(q "select id from admin.admins where username='nn5'"); N4ID=$(q "select id from admin.admins where username='nn4'"); N1ID=$(q "select id from admin.admins where username='nn1'")
unlock nn5; login nn5 >/dev/null; c nn5 GET /api/staff/me; S5=$ST
c nn1 POST /api/admin/staff/$N5ID/reinvite; RE="$ST $(echo "$BODY" | jget "[d['pending'], 'setupCode' in d]")"; RR=$(q "select id from admin.staff_requests where action='reinvite' and executed_at is null")
unlock nn2; login nn2 >/dev/null; c nn2 POST /api/admin/staff-requests/$RR/approve; REC=$(echo "$BODY" | jget "d.get('setupCode','')")
ok "re-inviting an ADMIN (lost phone, lost recovery codes) is two-person; approval returns a fresh setup code" "$RE $ST $(echo $REC | grep -cE '^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$')" "200 [True, False] 200 1"
ok "re-invited: back to INVITED with no password, authenticator, recovery codes or sessions; their old session is dead" "$(q "select status, password_hash is null, totp_secret is null from admin.admins where username='nn5'") $(q "select count(*) from admin.recovery_codes where admin_id='$N5ID'") $(q "select count(*) from admin.staff_sessions where staff_id='$N5ID'") $S5 $(c nn5 GET /api/staff/me; echo $ST)" "INVITED|t|t 0 0 200 401"
setup nn5 "$REC" >/dev/null; ok "the new setup code brings the person back (with a new password and authenticator)" "$(q "select status from admin.admins where username='nn5'")" ACTIVE
# the 'too few administrators' guard. Active now: nn1, nn2, nn4, nn5. nn1 asks to disable nn4 and nn5; nn4 asks to disable nn1; nn2 approves in turn.
c nn1 POST /api/admin/staff/$N4ID/disable; RA=$(echo "$BODY" | jget "d['id']"); c nn1 POST /api/admin/staff/$N5ID/disable; RC=$(echo "$BODY" | jget "d['id']")
unlock nn4; login nn4 >/dev/null; c nn4 POST /api/admin/staff/$N1ID/disable; RB=$(echo "$BODY" | jget "d['id']")
unlock nn2; login nn2 >/dev/null; c nn2 POST /api/admin/staff-requests/$RA/approve; G1=$ST; c nn2 POST /api/admin/staff-requests/$RC/approve; G3=$ST
c nn2 POST /api/admin/staff-requests/$RB/approve; G2="$ST $(code_of)"
ok "an administrator can be disabled with approval while enough remain (nn4, then nn5)" "$G1 $G3 $(q "select string_agg(username || ':' || status, ',' order by username) from admin.admins where username in ('nn4','nn5')")" "200 200 nn4:DISABLED,nn5:DISABLED"
ok "...but not when it would leave fewer than two active administrators (only nn1 and nn2 are left)" "$G2 $(q "select status from admin.admins where username='nn1'")" "409 GATE_TOO_FEW_ADMINS ACTIVE"
c nn2 GET /api/admin/staff; ok "the directory lists everyone with role and status" "$(echo "$BODY" | jget "sorted((s['username'], s['status']) for s in d['staff'])")" "[('nn1', 'ACTIVE'), ('nn2', 'ACTIVE'), ('nn3', 'INVITED'), ('nn4', 'DISABLED'), ('nn5', 'DISABLED'), ('pat', 'DISABLED')]"
ok "audit: invitations, requests, setup, disable, re-invite, password, authenticator and recovery events are recorded" "$(q "select count(*) filter (where action='STAFF_INVITED') >= 5 and count(*) filter (where action='STAFF_SETUP_COMPLETE') >= 5 and count(*) filter (where action='STAFF_DISABLE') = 3 and count(*) filter (where action='STAFF_REINVITE') = 1 and count(*) filter (where action='STAFF_PASSWORD_CHANGED') = 1 and count(*) filter (where action='STAFF_AUTHENTICATOR_REPLACED') = 2 and count(*) filter (where action='STAFF_RECOVERY_CODES_REPLACED') = 1 and count(*) filter (where action='STAFF_RECOVERY_CODE_USED') = 1 and count(*) filter (where action='STAFF_REQUEST_CANCELLED') = 1 from ops.audit")" t
# ---- break-glass, and what the web app can never do ----
export DATABASE_URL="postgresql:///$DB"; $CLI reinvite --username nn1 > /tmp/bg.txt 2>&1; BG=$(codeof < /tmp/bg.txt); export DATABASE_URL="$DB_API"
ok "break-glass: the setup tool can re-invite someone when nobody is left to approve; it is recorded in the audit log" "$(q "select status from admin.admins where username='nn1'") $(echo $BG | grep -c .) $(q "select count(*) from ops.audit where action='STAFF_REINVITE_BREAK_GLASS'")" "INVITED 1 1"
DENIED=0; for t in admin.setup_codes admin.recovery_codes admin.staff_requests; do PGPASSWORD=devpass psql -X -h 127.0.0.1 -U app_api $DB -c "select 1 from $t" 2>&1 | grep -q "permission denied" && DENIED=$((DENIED+1)); done
for fn in "admin.invite_staff('00000000-0000-0000-0000-000000000000',NULL,'x','xyz','ADMIN','\\x00',1)" "admin.staff_action('00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000','invite','{}','\\x00',1)"; do PGPASSWORD=devpass psql -X -h 127.0.0.1 -U app_api $DB -c "select $fn" 2>&1 | grep -q "permission denied" && DENIED=$((DENIED+1)); done
ok "the web app's database account cannot read the code tables or call the internal invite functions directly" "$DENIED" 5
[ $F = 0 ] && echo "ALL STAFF ACCOUNT CHECKS PASS" || echo "SOME STAFF ACCOUNT CHECKS FAILED"
