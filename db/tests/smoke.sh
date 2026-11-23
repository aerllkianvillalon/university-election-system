#!/usr/bin/env bash
# Smoke test: applies the migration to a scratch DB and checks the core invariants.
set -u; DB=${DB:-evtest}; P="psql -X -q -tA -v ON_ERROR_STOP=1 $DB"
dropdb --if-exists $DB; createdb $DB; $P -f db/migrations/shared/0001_core.sql >/dev/null || exit 1
$P -c "INSERT INTO org.organizations(slug,name) VALUES ('tgo','x')" 2>&1 | grep -q reserved && echo "PASS reserved slug blocked"
$P -c "INSERT INTO org.organizations(slug,name) VALUES ('ok','T.G.O.')" 2>&1 | grep -q reserved && echo "PASS normalized name blocked"
$P >/tmp/ids <<'SQL'
WITH o AS (INSERT INTO org.organizations(slug,name) VALUES ('bsit','BS IT Society') RETURNING id),
e AS (INSERT INTO election.elections(org_id,status,opens_at,closes_at) SELECT id,'OPEN',now()-interval '1h',now()+interval '1h' FROM o RETURNING id),
v AS (INSERT INTO election.voters(election_id,student_id,channel) SELECT id,'2026-00001','ONLINE' FROM e RETURNING id,election_id)
SELECT election_id||' '||id FROM v;
SQL
read E V < /tmp/ids
cast() { $P -c "SELECT ballots.cast_ballot('$E','1','$V',decode('$1','hex'),decode('aa$1','hex'),decode('cc$1','hex'))"; }
export -f cast; export P E V
seq 10 59 | xargs -P 50 -I{} bash -c "cast() { $P -c \"SELECT ballots.cast_ballot('$E',1,'$V',decode('{}','hex'),decode('aa{}','hex'),decode('cc{}','hex'))\"; }; cast" | sort | uniq -c
echo "participation=$($P -c 'SELECT count(*) FROM participation.participation') inbox=$($P -c 'SELECT count(*) FROM ballots.inbox')  (expect 1 and 1)"
$P -c "CALL ballots.seal('$E','main',1,true)"
echo "sealed=$($P -c 'SELECT count(*) FROM ballots.ballots') inbox_left=$($P -c 'SELECT count(*) FROM ballots.inbox') verify_bad=$($P -c "SELECT ballots.verify_chain('$E','main')")"
$P -c "UPDATE ballots.ballots SET ciphertext='\x00'" 2>&1 | grep -q insert-only && echo "PASS ballot update blocked"
