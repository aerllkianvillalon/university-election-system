-- Registration with course / year / section: checked against the roll, and a wrong pick fails like any bad registration.
\set ON_ERROR_STOP on
BEGIN;
DO $$DECLARE o uuid; e uuid; v uuid; r uuid;
BEGIN
  INSERT INTO org.organizations(slug,name) VALUES ('rc-a','A') RETURNING id INTO o;
  INSERT INTO election.elections(org_id) VALUES (o) RETURNING id INTO e;
  INSERT INTO election.voters(election_id,student_id,channel,attrs) VALUES (e,'S1','ONLINE','{"program":"BSIT","year":"2","section":"A","other":"x"}') RETURNING id INTO v;
  INSERT INTO election.voters(election_id,student_id,channel,attrs) VALUES (e,'S2','ONLINE','{"program":"BSED","year":"1","section":"B"}');
  INSERT INTO identity.vouchers(voter_id,voucher_hash,expires_at) VALUES (v,'\x01',now()+interval '1 day');
  IF election.public_choices(e)->'program' <> '["BSED","BSIT"]'::jsonb THEN RAISE EXCEPTION 'choices program: %', election.public_choices(e); END IF;
  IF election.public_choices(e) ? 'other' THEN RAISE EXCEPTION 'other attribute must not be listed'; END IF;
  IF identity.register_checked(e,'S1','\x01','h','{"program":"BSED","year":"2","section":"A"}') IS NOT NULL THEN RAISE EXCEPTION 'wrong course accepted'; END IF;
  IF identity.register_checked(e,'S1','\x01','h','{"program":"BSIT","year":"3"}') IS NOT NULL THEN RAISE EXCEPTION 'wrong year accepted'; END IF;
  IF EXISTS (SELECT 1 FROM identity.vouchers WHERE voter_id=v AND used_at IS NOT NULL) THEN RAISE EXCEPTION 'a wrong pick used up the voucher'; END IF;
  r := identity.register_checked(e,'S1','\x01','h','{"program":"BSIT","year":"2","section":"A"}');
  IF r IS DISTINCT FROM v THEN RAISE EXCEPTION 'right pick refused'; END IF;
  RAISE NOTICE 'register_choices ok';
END$$;
ROLLBACK;
