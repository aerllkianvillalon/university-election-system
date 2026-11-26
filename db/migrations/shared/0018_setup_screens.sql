-- Setup screens: read what is already set up, set the voting times, and take back a mistake (before the election is locked).
-- Same rules as the other admin functions: this organization's staff only, edits only while the election is DRAFT or CONFIGURED.

CREATE FUNCTION admin.setup_overview(p_election uuid, p_staff uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e election.elections%ROWTYPE;
BEGIN IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT * INTO e FROM election.elections WHERE id = p_election;
  RETURN jsonb_build_object(
    'status', e.status, 'opensAt', e.opens_at, 'closesAt', e.closes_at,
    'electionKeySet', e.public_key IS NOT NULL, 'signingKeySet', e.signing_key IS NOT NULL,
    'rollCount', (SELECT count(*) FROM election.voters WHERE election_id = p_election),
    'withoutVoucher', (SELECT count(*) FROM election.voters v WHERE v.election_id = p_election AND v.channel = 'ONLINE' AND NOT EXISTS (SELECT 1 FROM identity.vouchers x WHERE x.voter_id = v.id)),
    'positions', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'seats', p.seats, 'minSelections', p.min_sel, 'allowAbstain', p.allow_abstain,
        'candidates', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'platform', c.platform) ORDER BY c.name) FROM election.candidates c WHERE c.position_id = p.id), '[]'::jsonb)) ORDER BY p.sort, p.title)
      FROM election.positions p WHERE p.election_id = p_election), '[]'::jsonb)); END$$;

CREATE FUNCTION admin.set_window(p_election uuid, p_staff uuid, p_opens timestamptz, p_closes timestamptz) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p_opens IS NULL OR p_closes IS NULL OR p_closes <= p_opens OR p_closes <= now() THEN RAISE EXCEPTION 'GATE:BAD_WINDOW'; END IF;
  UPDATE election.elections SET opens_at = p_opens, closes_at = p_closes WHERE id = p_election AND status IN ('DRAFT','CONFIGURED','LOCKED'); IF NOT FOUND THEN RAISE EXCEPTION 'GATE:BAD_STATE'; END IF;
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'WINDOW_SET', jsonb_build_object('opens', p_opens, 'closes', p_closes)); END$$;

CREATE FUNCTION admin.remove_candidate(p_election uuid, p_staff uuid, p_candidate uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE nm text;
BEGIN PERFORM admin.editable(p_election, p_staff);
  DELETE FROM election.candidates WHERE id = p_candidate AND election_id = p_election RETURNING name INTO nm; IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'CANDIDATE_REMOVE', jsonb_build_object('name', nm)); END$$;

CREATE FUNCTION admin.remove_position(p_election uuid, p_staff uuid, p_position uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t text;
BEGIN PERFORM admin.editable(p_election, p_staff);
  IF NOT EXISTS (SELECT 1 FROM election.positions WHERE id = p_position AND election_id = p_election) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  DELETE FROM election.candidates WHERE position_id = p_position AND election_id = p_election;
  DELETE FROM election.positions WHERE id = p_position AND election_id = p_election RETURNING title INTO t;
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'POSITION_REMOVE', jsonb_build_object('title', t)); END$$;

-- Start over with the roll (only before the lock, and only while no voucher has been issued, so nobody is left holding a code for a voter who was removed).
CREATE FUNCTION admin.clear_roll(p_election uuid, p_staff uuid) RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n int;
BEGIN PERFORM admin.editable(p_election, p_staff);
  IF EXISTS (SELECT 1 FROM identity.vouchers x JOIN election.voters v ON v.id = x.voter_id WHERE v.election_id = p_election) THEN RAISE EXCEPTION 'GATE:VOUCHERS_ISSUED'; END IF;
  DELETE FROM election.voters WHERE election_id = p_election; GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'ROLL_CLEAR', jsonb_build_object('rows', n)); RETURN n; END$$;

REVOKE ALL ON FUNCTION admin.setup_overview, admin.set_window, admin.remove_candidate, admin.remove_position, admin.clear_roll FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.setup_overview, admin.set_window, admin.remove_candidate, admin.remove_position, admin.clear_roll TO app_api;
