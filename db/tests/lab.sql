-- Lab session tests: every rejection path, one-booth-one-voter, anonymity of closed sessions. Run after migrations 0001-0007.
DO $$DECLARE o uuid; e uuid; v1 uuid; v2 uuid; v3 uuid; b1 uuid; b2 uuid; b3 uuid; r jsonb; t1 bytea := '\x01'; t2 bytea := '\x02'; t3 bytea := '\x03'; t4 bytea := '\x04'; sid uuid; x text;
BEGIN
  INSERT INTO org.organizations(slug,name) VALUES ('labtest','Lab Test Org') RETURNING id INTO o;
  INSERT INTO election.elections(org_id,status,opens_at,closes_at,close_grace_seconds) VALUES (o,'OPEN',now()-interval '1h',now()+interval '1h',30) RETURNING id INTO e;
  INSERT INTO election.voters(election_id,student_id,channel) VALUES (e,'L1','LAB') RETURNING id INTO v1;
  INSERT INTO election.voters(election_id,student_id,channel) VALUES (e,'L2','LAB') RETURNING id INTO v2;
  INSERT INTO election.voters(election_id,student_id,channel) VALUES (e,'O1','ONLINE') RETURNING id INTO v3;
  INSERT INTO lab.booths(label) VALUES ('B1') RETURNING id INTO b1; INSERT INTO lab.booths(label) VALUES ('B2') RETURNING id INTO b2; INSERT INTO lab.booths(label,enabled) VALUES ('B3',false) RETURNING id INTO b3;
  ASSERT lab.check_in(e,'O1')->>'reason' = 'WRONG_CHANNEL', 'online voter at lab'; ASSERT lab.check_in(e,'ZZZ')->>'reason' = 'NOT_ON_ROLL', 'unknown id';
  ASSERT (lab.check_in(e,'L1')->>'ok')::boolean, 'eligible check-in';
  ASSERT lab.issue_session(e,v1,b3,t1)->>'reason' = 'BOOTH_DISABLED', 'disabled booth';
  ASSERT lab.issue_session(e,v1,gen_random_uuid(),t1)->>'reason' = 'BOOTH_NOT_REGISTERED', 'unregistered booth';
  ASSERT (lab.issue_session(e,v1,b1,t1)->>'ok')::boolean, 'issue';
  ASSERT lab.issue_session(e,v2,b1,t2)->>'reason' = 'BOOTH_BUSY', 'booth busy';
  ASSERT lab.issue_session(e,v1,b2,t2)->>'reason' = 'SESSION_ACTIVE', 'one voter, one booth';
  ASSERT lab.check_in(e,'L1')->>'reason' = 'SESSION_ACTIVE', 'check-in during session';
  ASSERT lab.start_session(t1,b2)->>'reason' = 'WRONG_BOOTH', 'wrong booth'; ASSERT lab.start_session('\x99',b1)->>'reason' = 'INVALID_SESSION', 'unknown token';
  ASSERT (lab.start_session(t1,b1)->>'ok')::boolean, 'start'; ASSERT lab.start_session(t1,b1)->>'reason' = 'REUSED', 'start twice';
  ASSERT lab.cast_ballot(t1,b2,1,'\xaa','\xbb') = 'WRONG_BOOTH', 'cast from wrong booth';
  ASSERT lab.cast_ballot(t1,b1,1,'\xaa','\xbb') = 'RECORDED', 'cast';
  ASSERT lab.cast_ballot(t1,b1,1,'\xaa','\xbb') = 'REUSED', 'cast twice with one session';
  ASSERT lab.check_in(e,'L1')->>'reason' = 'ALREADY_VOTED', 'already voted';
  ASSERT (SELECT count(*) FROM participation.participation) = 1 AND (SELECT count(*) FROM ballots.inbox) = 1, 'one participation, one inbox row';
  SELECT booth_id::text INTO x FROM lab.voting_sessions WHERE token_hash = t1; ASSERT x IS NULL, 'booth erased after submit';
  ASSERT (SELECT issued_at = date_trunc('hour', issued_at) FROM lab.voting_sessions WHERE token_hash = t1), 'time truncated to the hour after submit';
  -- expiry, cancellation
  PERFORM lab.issue_session(e,v2,b2,t2); UPDATE lab.voting_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = t2;
  ASSERT lab.start_session(t2,b2)->>'reason' = 'EXPIRED', 'expired';
  r := lab.issue_session(e,v2,b2,t3); ASSERT lab.cancel_session((r->>'session_id')::uuid,'proctor'), 'cancel';
  ASSERT lab.start_session(t3,b2)->>'reason' = 'CANCELLED', 'cancelled';
  -- freeze and window close mid-session
  r := lab.issue_session(e,v2,b2,t4); ASSERT (lab.start_session(t4,b2)->>'ok')::boolean, 'start 2';
  UPDATE election.elections SET frozen = true WHERE id = e; ASSERT lab.cast_ballot(t4,b2,1,'\xcc','\xdd') = 'FROZEN', 'frozen mid-session';
  UPDATE election.elections SET frozen = false, closes_at = now() - interval '10 seconds' WHERE id = e;
  ASSERT lab.cast_ballot(t4,b2,1,'\xcc','\xdd') = 'RECORDED', 'inside close grace window';
  UPDATE election.elections SET closes_at = now() - interval '1 hour' WHERE id = e; ASSERT lab.check_in(e,'L2')->>'reason' = 'WINDOW_CLOSED', 'after grace';
  UPDATE election.elections SET closes_at = now() + interval '1 hour', paused = true WHERE id = e; ASSERT lab.check_in(e,'L2')->>'reason' = 'PAUSED', 'paused';
  RAISE NOTICE 'PASS lab: all rejection paths, one voter one booth, anonymity of closed sessions';
END$$;
