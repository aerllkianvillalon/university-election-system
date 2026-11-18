-- Admin management: roll import (all-or-nothing with a report), positions, candidates, election key, vouchers, readiness report, audit trail. Editable only before LOCKED.
CREATE TABLE ops.audit(id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), staff_id uuid, election_id uuid, action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}');
ALTER TABLE ops.audit ENABLE ROW LEVEL SECURITY; REVOKE ALL ON ops.audit FROM PUBLIC;
CREATE FUNCTION admin.editable(p_election uuid, p_staff uuid) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF (SELECT status FROM election.elections WHERE id = p_election) NOT IN ('DRAFT','CONFIGURED') THEN RAISE EXCEPTION 'GATE:LOCKED'; END IF; END$$;

CREATE FUNCTION admin.import_roll(p_election uuid, p_staff uuid, p_rows jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record; errs jsonb := '[]'; seen text[] := '{}'; n int; why text;
BEGIN PERFORM admin.editable(p_election, p_staff);
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) = 0 THEN RAISE EXCEPTION 'GATE:EMPTY_ROLL'; END IF;
  FOR r IN SELECT value AS v, ordinality AS i FROM jsonb_array_elements(p_rows) WITH ORDINALITY LOOP
    why := CASE
      WHEN jsonb_typeof(r.v->'studentId') IS DISTINCT FROM 'string' OR length(r.v->>'studentId') NOT BETWEEN 1 AND 32 THEN 'BAD_STUDENT_ID'
      WHEN (r.v->>'studentId') = ANY (seen) THEN 'DUPLICATE_IN_FILE'
      WHEN EXISTS (SELECT 1 FROM election.voters WHERE election_id = p_election AND student_id = r.v->>'studentId') THEN 'ALREADY_ON_ROLL'
      WHEN COALESCE(r.v->>'channel', '') NOT IN ('ONLINE','LAB') THEN 'BAD_CHANNEL'          -- every voter gets exactly one channel
      WHEN jsonb_exists(r.v, 'email') AND position('@' IN COALESCE(r.v->>'email', '')) = 0 THEN 'BAD_EMAIL'
      WHEN jsonb_exists(r.v, 'attrs') AND jsonb_typeof(r.v->'attrs') IS DISTINCT FROM 'object' THEN 'BAD_ATTRS'
      ELSE NULL END;
    IF why IS NULL THEN seen := seen || (r.v->>'studentId'); ELSE errs := errs || jsonb_build_object('row', r.i, 'reason', why); END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN RETURN jsonb_build_object('ok', false, 'errors', errs); END IF;
  INSERT INTO election.voters(election_id, student_id, channel, attrs, roll_email)
    SELECT p_election, v->>'studentId', v->>'channel', COALESCE(v->'attrs', '{}'::jsonb), v->>'email' FROM jsonb_array_elements(p_rows) v;
  GET DIAGNOSTICS n = ROW_COUNT; INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'ROLL_IMPORT', jsonb_build_object('rows', n));
  RETURN jsonb_build_object('ok', true, 'inserted', n); END$$;

CREATE FUNCTION admin.add_position(p_election uuid, p_staff uuid, p_title text, p_seats int, p_min int, p_abstain boolean, p_scope jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE new_id uuid;
BEGIN PERFORM admin.editable(p_election, p_staff);
  INSERT INTO election.positions(election_id, title, seats, min_sel, allow_abstain, scope, sort) VALUES (p_election, p_title, p_seats, p_min, p_abstain, p_scope, (SELECT count(*) FROM election.positions WHERE election_id = p_election)) RETURNING election.positions.id INTO new_id;
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'POSITION_ADD', jsonb_build_object('title', p_title)); RETURN new_id; END$$;
CREATE FUNCTION admin.add_candidate(p_election uuid, p_staff uuid, p_position uuid, p_name text, p_platform text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE new_id uuid;
BEGIN PERFORM admin.editable(p_election, p_staff);
  IF NOT EXISTS (SELECT 1 FROM election.positions WHERE id = p_position AND election_id = p_election) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  INSERT INTO election.candidates(election_id, position_id, name, platform) VALUES (p_election, p_position, p_name, p_platform) RETURNING election.candidates.id INTO new_id;
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'CANDIDATE_ADD', jsonb_build_object('name', p_name)); RETURN new_id; END$$;
CREATE FUNCTION admin.set_election_key(p_election uuid, p_staff uuid, p_key bytea) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  UPDATE election.elections SET public_key = p_key WHERE id = p_election AND status IN ('DRAFT','CONFIGURED','LOCKED'); IF NOT FOUND THEN RAISE EXCEPTION 'GATE:BAD_STATE'; END IF;
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'KEY_SET', jsonb_build_object('fingerprint', encode(sha256(p_key), 'hex'))); END$$;

CREATE FUNCTION admin.voters_without_voucher(p_election uuid, p_staff uuid) RETURNS TABLE(voter_id uuid, student_id text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  RETURN QUERY SELECT v.id, v.student_id FROM election.voters v WHERE v.election_id = p_election AND v.channel = 'ONLINE' AND NOT EXISTS (SELECT 1 FROM identity.vouchers x WHERE x.voter_id = v.id); END$$;
CREATE FUNCTION admin.store_vouchers(p_election uuid, p_staff uuid, p_rows jsonb, p_days int) RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n int;
BEGIN IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  INSERT INTO identity.vouchers(voter_id, voucher_hash, expires_at) SELECT (x->>'voter_id')::uuid, decode(x->>'hash', 'hex'), now() + make_interval(days => p_days)
    FROM jsonb_array_elements(p_rows) x WHERE EXISTS (SELECT 1 FROM election.voters v WHERE v.id = (x->>'voter_id')::uuid AND v.election_id = p_election) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'VOUCHERS_ISSUED', jsonb_build_object('count', n)); RETURN n; END$$;

CREATE FUNCTION admin.readiness(p_election uuid, p_staff uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e election.elections%ROWTYPE; chk jsonb := '[]'; ok boolean := true;
  np int; nc int; nv int; nm int; nb int; nl int; bad bigint;
BEGIN IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT * INTO e FROM election.elections WHERE id = p_election;
  SELECT count(*) INTO np FROM election.positions WHERE election_id = p_election;
  SELECT count(*) INTO nc FROM election.positions p WHERE p.election_id = p_election AND NOT EXISTS (SELECT 1 FROM election.candidates c WHERE c.position_id = p.id);
  SELECT count(*) INTO nv FROM election.voters WHERE election_id = p_election;
  SELECT count(*) INTO nm FROM election.voters v WHERE v.election_id = p_election AND v.channel = 'ONLINE' AND NOT EXISTS (SELECT 1 FROM identity.vouchers x WHERE x.voter_id = v.id);
  SELECT count(*) INTO nl FROM election.voters WHERE election_id = p_election AND channel = 'LAB';
  SELECT count(*) INTO nb FROM lab.booths WHERE enabled; bad := ballots.verify_chain(p_election, 'main');
  chk := jsonb_build_array(
    jsonb_build_object('name','positions_exist','ok',np > 0,'detail',np || ' positions'),
    jsonb_build_object('name','every_position_has_candidates','ok',nc = 0 AND np > 0,'detail',nc || ' positions without candidates'),
    jsonb_build_object('name','roll_imported','ok',nv > 0,'detail',nv || ' voters'),
    jsonb_build_object('name','election_key_set','ok',e.public_key IS NOT NULL,'detail',''),
    jsonb_build_object('name','window_set','ok',e.opens_at IS NOT NULL AND e.closes_at > e.opens_at,'detail',''),
    jsonb_build_object('name','online_voters_have_vouchers','ok',nm = 0,'detail',nm || ' without a voucher'),
    jsonb_build_object('name','lab_booths_registered','ok',nl = 0 OR nb > 0,'detail',nb || ' enabled booths for ' || nl || ' lab voters'),
    jsonb_build_object('name','chain_verifies','ok',bad = 0,'detail',bad || ' broken links'));
  SELECT bool_and((c->>'ok')::boolean) INTO ok FROM jsonb_array_elements(chk) c;
  RETURN jsonb_build_object('ready', ok, 'checks', chk); END$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA admin FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.import_roll, admin.add_position, admin.add_candidate, admin.set_election_key, admin.voters_without_voucher, admin.store_vouchers, admin.readiness TO app_api;
