#!/usr/bin/env bash
# Package export/import: signature, encryption, chain, predecessor, duplicate participation, atomicity, replay, cumulative supersede.
set -u; EV="node packages/cli/ev.mjs"; W=/tmp/pkg; rm -rf $W; mkdir -p $W
E=aaaaaaaa-0000-4000-8000-000000000001; LABID=bbbbbbbb-0000-4000-8000-000000000001
U() { echo "postgresql://$(whoami)@/$1?host=/var/run/postgresql"; }
mk() { dropdb --if-exists $1 2>/dev/null; createdb $1
  for f in 0001_core 0002_identity 0003_contests 0004_hardening 0005_admin_lifecycle 0006_least_privilege 0007_lab 0008_sync; do psql -X -q -v ON_ERROR_STOP=1 $1 -f db/migrations/shared/$f.sql >/dev/null 2>&1 || { echo "migration $f failed"; exit 1; }; done
  psql -X -q $1 << 'SQL'
INSERT INTO org.organizations(id,slug,name) VALUES ('cccccccc-0000-4000-8000-000000000001','pkgorg','Pkg Org');
INSERT INTO election.elections(id,org_id,status,opens_at,closes_at) VALUES ('aaaaaaaa-0000-4000-8000-000000000001','cccccccc-0000-4000-8000-000000000001','OPEN',now()-interval '1h',now()+interval '1h');
INSERT INTO election.voters(id,election_id,student_id,channel) SELECT ('dddddddd-0000-4000-8000-00000000000'||g)::uuid,'aaaaaaaa-0000-4000-8000-000000000001','S'||g,CASE WHEN g=4 THEN 'ONLINE' ELSE 'LAB' END FROM generate_series(1,5) g;
SQL
}
vote() { psql -X -q $1 -c "DO \$\$DECLARE g int; BEGIN FOR g IN $2 LOOP
  PERFORM lab.issue_session('$E',('dddddddd-0000-4000-8000-00000000000'||g)::uuid,'eeeeeeee-0000-4000-8000-000000000001',decode(md5(g::text),'hex'));
  PERFORM lab.start_session(decode(md5(g::text),'hex'),'eeeeeeee-0000-4000-8000-000000000001');
  PERFORM lab.cast_ballot(decode(md5(g::text),'hex'),'eeeeeeee-0000-4000-8000-000000000001',1,gen_random_bytes(32),gen_random_bytes(300)); END LOOP; END\$\$"; psql -X -q $1 -c "CALL ballots.seal('$E','lab-1',1,true)"; }
mk evlab1; mk evcen; mk evcen2
$EV keygen --out $W/lab >/dev/null; $EV transfer-keygen --out $W/tr >/dev/null; $EV transfer-keygen --out $W/wrong >/dev/null
PUB=$(python3 -c "import base64;print(base64.b64decode(open('$W/lab/signing.pub').read()).hex())")
for d in evcen evcen2; do psql -X -q $d -c "INSERT INTO sync.labs(id,election_id,name,chain_id,public_key) VALUES ('$LABID','$E','Lab 1','lab-1',decode('$PUB','hex'))"; done
psql -X -q evlab1 -c "INSERT INTO lab.booths(id,label) VALUES ('eeeeeeee-0000-4000-8000-000000000001','B1')"
vote evlab1 "1..3"
exp() { $EV pkg-export --db $(U evlab1) --election $E --lab $LABID --chain lab-1 --key $W/lab/signing.key --recipient $W/tr/transfer.pub --type $1 --out $2 | sed 's/^/  /'; }
imp() { $EV pkg-import --db $(U $1) --file $2 --key ${3:-$W/tr/transfer.key} 2>&1 | head -1 | sed 's/^/  /'; }
cnt() { echo "  central: ballots=$(psql -X -tA $1 -c "select count(*) from ballots.ballots") lab-participation=$(psql -X -tA $1 -c "select count(*) from participation.participation") verify_bad=$(psql -X -tA $1 -c "select ballots.verify_chain('$E','lab-1')")"; }
exp INTERIM $W/p1.evpkg
echo "1 import INTERIM (3 ballots):"; imp evcen $W/p1.evpkg; cnt evcen
echo "2 replay:"; imp evcen $W/p1.evpkg
python3 - << PY
import json,base64,copy
p=json.load(open('$W/p1.evpkg'))
def w(n,q): json.dump(q,open('$W/'+n,'w'))
q=copy.deepcopy(p); b=bytearray(base64.b64decode(q['payload'])); b[50]^=1; q['payload']=base64.b64encode(bytes(b)).decode(); w('flip.evpkg',q)
q=copy.deepcopy(p); q['manifest']['ballot_count']+=1; w('manif.evpkg',q)
q=copy.deepcopy(p); q['manifest']['version']=2; w('ver.evpkg',q)
q=copy.deepcopy(p); q['manifest']['lab_id']='bbbbbbbb-0000-4000-8000-0000000000ff'; w('lab.evpkg',q)
PY
echo "3 bit-flipped payload:"; imp evcen2 $W/flip.evpkg
echo "4 modified manifest:"; imp evcen2 $W/manif.evpkg
echo "5 wrong version:"; imp evcen2 $W/ver.evpkg
echo "6 unknown lab:"; imp evcen2 $W/lab.evpkg
echo "7 wrong recipient key:"; imp evcen2 $W/p1.evpkg $W/wrong/transfer.key
psql -X -q evcen2 -c "INSERT INTO participation.participation VALUES ('$E',1,'dddddddd-0000-4000-8000-000000000001','ONLINE',now(),'\\x00')"
echo "8 voter already voted online (duplicate participation):"; imp evcen2 $W/p1.evpkg; echo "  after failure: ballots=$(psql -X -tA evcen2 -c 'select count(*) from ballots.ballots') lab-participation=$(psql -X -tA evcen2 -c "select count(*) from participation.participation where channel='LAB'") quarantined=$(psql -X -tA evcen2 -c 'select count(*) from sync.quarantine')"
vote evlab1 "5..5"; exp FINAL $W/p2.evpkg
echo "9 cumulative FINAL (4 ballots) supersedes INTERIM:"; imp evcen $W/p2.evpkg; cnt evcen
echo "10 old package after newer one:"; imp evcen $W/p1.evpkg
