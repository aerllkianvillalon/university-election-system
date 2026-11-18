-- Lifecycle, dual approval and freeze tests. Run: psql -v ON_ERROR_STOP=1 DB -f db/tests/lifecycle.sql (after migrations 0001-0006)
CREATE FUNCTION pg_temp.fails(q text, pat text) RETURNS void LANGUAGE plpgsql AS $$BEGIN EXECUTE q; RAISE EXCEPTION 'expected failure not raised: %', q;
EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE pat THEN RAISE; END IF; END$$;
DO $$DECLARE o uuid; o2 uuid; e uuid; A uuid; B uuid; C uuid; p uuid; ap uuid; n int;
BEGIN
  INSERT INTO org.organizations(slug,name) VALUES ('lifeorg','Life Org') RETURNING id INTO o; INSERT INTO org.organizations(slug,name) VALUES ('otherorg','Other Org') RETURNING id INTO o2;
  INSERT INTO admin.admins(org_id,name) VALUES (o,'A') RETURNING id INTO A; INSERT INTO admin.admins(org_id,name) VALUES (o,'B') RETURNING id INTO B; INSERT INTO admin.admins(org_id,name) VALUES (o2,'C') RETURNING id INTO C;
  INSERT INTO election.elections(org_id,status,opens_at,closes_at) VALUES (o,'CONFIGURED',now()-interval '1h',now()+interval '1h') RETURNING id INTO e;
  PERFORM pg_temp.fails(format('SELECT admin.request_action(%L,''lock'',''{}'',%L)', e, A), 'GATE:NO_POSITIONS');
  INSERT INTO election.positions(election_id,title,seats) VALUES (e,'President',1) RETURNING id INTO p;
  PERFORM pg_temp.fails(format('SELECT admin.request_action(%L,''lock'',''{}'',%L)', e, A), 'GATE:POSITION_WITHOUT_CANDIDATES');
  INSERT INTO election.candidates(election_id,position_id,name) VALUES (e,p,'X');
  PERFORM pg_temp.fails(format('SELECT admin.request_action(%L,''lock'',''{}'',%L)', e, A), 'GATE:NO_VOTERS');
  INSERT INTO election.voters(election_id,student_id,channel) VALUES (e,'s1','ONLINE');
  PERFORM pg_temp.fails(format('SELECT admin.request_action(%L,''lock'',''{}'',%L)', e, C), 'FORBIDDEN');
  ap := admin.request_action(e,'lock','{}',A);
  PERFORM pg_temp.fails(format('SELECT admin.approve(%L,%L)', ap, A), 'SAME_ADMIN');
  PERFORM pg_temp.fails(format('SELECT admin.approve(%L,%L)', ap, C), 'FORBIDDEN');
  PERFORM admin.approve(ap, B); ASSERT (SELECT status FROM election.elections WHERE id=e) = 'LOCKED', 'lock needs two admins';
  PERFORM pg_temp.fails(format('SELECT admin.request_action(%L,''open'',''{}'',%L)', e, A), 'GATE:NO_ELECTION_KEY');
  UPDATE election.elections SET public_key = '\x01' WHERE id = e;
  PERFORM pg_temp.fails(format('SELECT admin.request_action(%L,''open'',''{}'',%L)', e, A), 'GATE:NO_SIGNING_KEY');
  PERFORM pg_temp.fails(format('SELECT admin.set_signing_key(%L,%L,''\x0102'')', e, A), 'GATE:BAD_KEY');
  PERFORM admin.set_signing_key(e, A, decode(repeat('07',32),'hex'));
  PERFORM admin.approve(admin.request_action(e,'open','{}',B), A); ASSERT (SELECT status FROM election.elections WHERE id=e) = 'OPEN', 'open';
  PERFORM pg_temp.fails(format('SELECT admin.request_action(%L,''extend'',''{"minutes":2000}'',%L)', e, A), 'GATE:EXTENSION_CAP');
  PERFORM admin.approve(admin.request_action(e,'extend','{"minutes":60}',A), B);
  ASSERT (SELECT closes_at FROM election.elections WHERE id=e) > now() + interval '1h 59m', 'extension applied';
  -- freeze: single admin acts, blocks voting, lifts itself after 15 minutes unless a different admin ratifies
  PERFORM admin.freeze(e, A); ASSERT (SELECT frozen FROM election.elections WHERE id=e), 'frozen';
  ASSERT ballots.cast_ballot(e,1,(SELECT id FROM election.voters WHERE election_id=e),'\x01','\x02','\x03') = 'FROZEN', 'vote blocked while frozen';
  UPDATE election.elections SET freeze_started_at = now() - interval '16 minutes' WHERE id = e;
  n := admin.lift_expired_freezes(); ASSERT n = 1 AND NOT (SELECT frozen FROM election.elections WHERE id=e), 'unratified freeze lifted';
  PERFORM admin.freeze(e, A); PERFORM pg_temp.fails(format('SELECT admin.ratify_freeze(%L,%L)', e, A), 'SAME_ADMIN_OR_BAD_STATE');
  PERFORM admin.ratify_freeze(e, B); UPDATE election.elections SET freeze_started_at = now() - interval '16 minutes' WHERE id = e;
  n := admin.lift_expired_freezes(); ASSERT n = 0 AND (SELECT frozen FROM election.elections WHERE id=e), 'ratified freeze stays';
  PERFORM admin.approve(admin.request_action(e,'unfreeze','{}',B), A); ASSERT NOT (SELECT frozen FROM election.elections WHERE id=e), 'unfreeze needs two admins';
  RAISE NOTICE 'PASS lifecycle: gates, dual approval, same-org, extension cap, freeze/ratify/auto-lift';
END$$;
