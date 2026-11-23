#!/usr/bin/env bash
# Seeds a local election and starts the real API on :3001 for browser tests. Needs local Postgres. Run from repo root.
#   bash server/live-dev.sh up     -> creates DB evlive, starts API, writes /tmp/live.env (ELECTION_ID etc.)
#   bash server/live-dev.sh down   -> stops the API
set -eu; DB=evlive; ENVF=/tmp/live.env
if [ "${1:-up}" = down ]; then [ -f /tmp/live-api.pid ] && kill "$(cat /tmp/live-api.pid)" 2>/dev/null || true; rm -f /tmp/live-api.pid; exit 0; fi
[ -f /tmp/live-api.pid ] && kill "$(cat /tmp/live-api.pid)" 2>/dev/null || true
dropdb --if-exists $DB; createdb $DB
for f in db/migrations/shared/*.sql; do psql -X -q -v ON_ERROR_STOP=1 $DB -f $f >/dev/null; done
E=$(psql -X -tA $DB <<'SQL' | head -1
WITH o AS (INSERT INTO org.organizations(slug,name) VALUES ('bsit','BS IT Society') RETURNING id),
e AS (INSERT INTO election.elections(org_id,status,opens_at,closes_at) SELECT id,'OPEN',now()-interval '1h',now()+interval '8h' FROM o RETURNING id),
v AS (INSERT INTO election.voters(election_id,student_id,channel,attrs,roll_email)
      SELECT e.id, s.sid, 'ONLINE', jsonb_build_object('program', s.prog), s.sid||'@test.invalid' FROM e, (VALUES ('2026-00001','BSIT'),('2026-00002','BSED'),('2026-00003','BSIT'),('2026-00004','BSIT'),('2026-00005','BSIT'),('2026-00006','BSIT')) s(sid,prog) RETURNING id, election_id, student_id),
x AS (INSERT INTO identity.vouchers SELECT id, hmac('DEMO-'||right(student_id,1),'pepper','sha256'), now()+interval '1 day' FROM v)
SELECT DISTINCT election_id FROM v;
SQL
)
psql -X -q $DB -c "INSERT INTO election.positions(election_id,title,seats,scope,sort) VALUES
 ('$E','President',1,'{\"all\":true}',1),('$E','Senators',2,'{\"all\":true}',2),
 ('$E','BSIT Rep',1,'{\"match\":{\"program\":\"BSIT\"}}',3),('$E','BSED Rep',1,'{\"match\":{\"program\":\"BSED\"}}',4)" \
 -c "INSERT INTO election.candidates(election_id,position_id,name,platform)
     SELECT p.election_id,p.id,p.title||' '||g, 'Platform of '||p.title||' '||g FROM election.positions p, generate_series(1,3) g WHERE g <= CASE WHEN p.title='Senators' THEN 3 ELSE 2 END"
# Real ceremony output (Shamir shares + signing key), so the browser tests can run the real tally and import it.
W=/tmp/live-cer; rm -rf $W; node packages/cli/ev.mjs keygen --out $W >/dev/null
PUB=$(cat $W/election.pub)
SK=$(cd packages/cli && node -e "import('shamir-secret-sharing').then(async m=>{const fs=require('fs');const sh=[1,3,5].map(i=>new Uint8Array(Buffer.from(fs.readFileSync('$W/share-'+i+'.txt','utf8'),'base64')));console.log(Buffer.from(await m.combine(sh)).toString('base64'))})")
hex() { python3 -c "import base64,sys;print(base64.b64decode(open('$1').read()).hex())"; }
psql -X -q $DB -c "UPDATE election.elections SET public_key = decode('$(hex $W/election.pub)','hex'), signing_key = decode('$(hex $W/signing.pub)','hex') WHERE id='$E'"
# Staff: three administrators (a1, a2, a3) and a proctor. Secrets are random per run; the tests read them from $ENVF.
STAFF_KEY=$(openssl rand -hex 32); SHASH=$(cd server && node tools.mjs hash 'staff-pass-123'); ORG=$(psql -X -tA $DB -c "SELECT org_id FROM election.elections WHERE id='$E'")
for u in a1 a2 a3 p1; do eval "${u^^}_SECRET=$(openssl rand -hex 20)"; done
enc() { (cd server && STAFF_KEY=$STAFF_KEY node tools.mjs enc "$1"); }
psql -X -q -v h="$SHASH" $DB <<SQL
INSERT INTO admin.admins(org_id,name,username,role,password_hash,totp_secret) VALUES
 ('$ORG','Admin One','a1','ADMIN',:'h','\\x$(enc $A1_SECRET)'),('$ORG','Admin Two','a2','ADMIN',:'h','\\x$(enc $A2_SECRET)'),('$ORG','Admin Three','a3','ADMIN',:'h','\\x$(enc $A3_SECRET)'),('$ORG','Proctor One','p1','PROCTOR',:'h','\\x$(enc $P1_SECRET)');
SQL
# dev-only secrets below, so tests can decrypt the inbox and sign in as staff; a real election key never exists on this machine
cat > $ENVF <<EOT
ELECTION_ID=$E
ELECTION_PUBKEY=$PUB
ELECTION_SECRET=$SK
CEREMONY_DIR=$W
STAFF_KEY=$STAFF_KEY
A1_SECRET=$A1_SECRET
A2_SECRET=$A2_SECRET
A3_SECRET=$A3_SECRET
P1_SECRET=$P1_SECRET
EOT
(cd server && STAFF_KEY=$STAFF_KEY DATABASE_URL="postgresql://app_api:devpass@127.0.0.1/$DB" PEPPER=pepper REQUEST_KEY=rk RECEIPT_KEY=ck ELECTION_PUBKEY=$PUB PORT=3001 DEBUG_API=1 exec node index.mjs >/tmp/live-api.log 2>&1) &
echo $! > /tmp/live-api.pid; sleep 2; curl -sf http://127.0.0.1:3001/api/elections/$E/info >/dev/null && echo "API up. ELECTION_ID=$E"
