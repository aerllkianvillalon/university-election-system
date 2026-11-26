-- Setup, part 2: edit a position or candidate before the lock, candidate photos, and who may vote on a position (scope) with a count of eligible voters.
-- Same rules as before: this organization's staff only, edits only while DRAFT or CONFIGURED; functions only (no table grants).

CREATE FUNCTION admin.valid_scope(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p) = 'object' AND (
    p = '{"all": true}'::jsonb OR
    (p ? 'match' AND (SELECT count(*) FROM jsonb_object_keys(p)) = 1 AND jsonb_typeof(p->'match') = 'object'
       AND (SELECT count(*) FROM jsonb_object_keys(p->'match')) BETWEEN 1 AND 3
       AND NOT EXISTS (SELECT 1 FROM jsonb_each(p->'match') e WHERE jsonb_typeof(e.value) <> 'string' OR length(e.value #>> '{}') NOT BETWEEN 1 AND 80))) $$;

CREATE OR REPLACE FUNCTION admin.add_position(p_election uuid, p_staff uuid, p_title text, p_seats int, p_min int, p_abstain boolean, p_scope jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE new_id uuid;
BEGIN PERFORM admin.editable(p_election, p_staff);
  IF NOT admin.valid_scope(p_scope) THEN RAISE EXCEPTION 'GATE:BAD_SCOPE'; END IF;
  INSERT INTO election.positions(election_id, title, seats, min_sel, allow_abstain, scope, sort) VALUES (p_election, p_title, p_seats, p_min, p_abstain, p_scope, (SELECT count(*) FROM election.positions WHERE election_id = p_election)) RETURNING election.positions.id INTO new_id;
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'POSITION_ADD', jsonb_build_object('title', p_title)); RETURN new_id; END$$;

CREATE FUNCTION admin.update_position(p_election uuid, p_staff uuid, p_position uuid, p_title text, p_seats int, p_abstain boolean, p_scope jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN PERFORM admin.editable(p_election, p_staff);
  IF NOT admin.valid_scope(p_scope) THEN RAISE EXCEPTION 'GATE:BAD_SCOPE'; END IF;
  IF p_title IS NULL OR length(p_title) NOT BETWEEN 1 AND 120 OR p_seats NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'GATE:BAD_DETAILS'; END IF;
  UPDATE election.positions SET title = p_title, seats = p_seats, min_sel = least(min_sel, p_seats), allow_abstain = p_abstain, scope = p_scope WHERE id = p_position AND election_id = p_election;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'POSITION_EDIT', jsonb_build_object('title', p_title, 'seats', p_seats, 'scope', p_scope)); END$$;

CREATE FUNCTION admin.update_candidate(p_election uuid, p_staff uuid, p_candidate uuid, p_name text, p_platform text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN PERFORM admin.editable(p_election, p_staff);
  IF p_name IS NULL OR length(p_name) NOT BETWEEN 1 AND 120 OR (p_platform IS NOT NULL AND length(p_platform) > 1000) THEN RAISE EXCEPTION 'GATE:BAD_DETAILS'; END IF;
  UPDATE election.candidates SET name = p_name, platform = p_platform WHERE id = p_candidate AND election_id = p_election; IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'CANDIDATE_EDIT', jsonb_build_object('name', p_name)); END$$;

-- Photos: one small JPEG per candidate, kept in the database. The page shrinks the picture first; the server still checks size and type.
CREATE TABLE election.candidate_photos(candidate_id uuid PRIMARY KEY REFERENCES election.candidates ON DELETE CASCADE, election_id uuid NOT NULL REFERENCES election.elections, data bytea NOT NULL CHECK (length(data) BETWEEN 100 AND 262144), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE election.candidate_photos ENABLE ROW LEVEL SECURITY; REVOKE ALL ON election.candidate_photos FROM PUBLIC;

CREATE FUNCTION admin.set_candidate_photo(p_election uuid, p_staff uuid, p_candidate uuid, p_data bytea) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN PERFORM admin.editable(p_election, p_staff);
  IF p_data IS NULL OR length(p_data) NOT BETWEEN 100 AND 262144 OR get_byte(p_data, 0) <> 255 OR get_byte(p_data, 1) <> 216 OR get_byte(p_data, 2) <> 255 THEN RAISE EXCEPTION 'GATE:BAD_PHOTO'; END IF;   -- JPEG only (FF D8 FF), 256 KB at most
  IF NOT EXISTS (SELECT 1 FROM election.candidates WHERE id = p_candidate AND election_id = p_election) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  INSERT INTO election.candidate_photos(candidate_id, election_id, data) VALUES (p_candidate, p_election, p_data) ON CONFLICT (candidate_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now();
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'CANDIDATE_PHOTO_SET', jsonb_build_object('candidate', p_candidate, 'bytes', length(p_data))); END$$;
CREATE FUNCTION admin.clear_candidate_photo(p_election uuid, p_staff uuid, p_candidate uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN PERFORM admin.editable(p_election, p_staff);
  DELETE FROM election.candidate_photos WHERE candidate_id = p_candidate AND election_id = p_election;
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'CANDIDATE_PHOTO_CLEAR', jsonb_build_object('candidate', p_candidate)); END$$;
CREATE FUNCTION admin.candidate_photo(p_election uuid, p_staff uuid, p_candidate uuid) RETURNS bytea LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  RETURN (SELECT data FROM election.candidate_photos WHERE candidate_id = p_candidate AND election_id = p_election); END$$;
-- Public: only once the election is locked (not while staff are still drafting), and never for a withdrawn candidate.
CREATE FUNCTION election.candidate_photo_public(p_election uuid, p_candidate uuid) RETURNS bytea LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT ph.data FROM election.candidate_photos ph JOIN election.candidates c ON c.id = ph.candidate_id JOIN election.elections e ON e.id = c.election_id
   WHERE ph.candidate_id = p_candidate AND e.id = p_election AND c.withdrawn_at IS NULL AND e.status IN ('LOCKED','OPEN','CLOSED','TALLIED','CERTIFIED','ARCHIVED') $$;
CREATE FUNCTION election.candidates_with_photo(p_candidates uuid[]) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT candidate_id FROM election.candidate_photos WHERE candidate_id = ANY (p_candidates) $$;

CREATE OR REPLACE FUNCTION admin.setup_overview(p_election uuid, p_staff uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e election.elections%ROWTYPE;
BEGIN IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT * INTO e FROM election.elections WHERE id = p_election;
  RETURN jsonb_build_object(
    'status', e.status, 'opensAt', e.opens_at, 'closesAt', e.closes_at,
    'electionKeySet', e.public_key IS NOT NULL, 'signingKeySet', e.signing_key IS NOT NULL,
    'rollCount', (SELECT count(*) FROM election.voters WHERE election_id = p_election),
    'withoutVoucher', (SELECT count(*) FROM election.voters v WHERE v.election_id = p_election AND v.channel = 'ONLINE' AND NOT EXISTS (SELECT 1 FROM identity.vouchers x WHERE x.voter_id = v.id)),
    'attributes', COALESCE((SELECT jsonb_object_agg(k, vals) FROM (SELECT t.key AS k, (array_agg(DISTINCT t.value ORDER BY t.value))[1:50] AS vals FROM election.voters v, jsonb_each_text(v.attrs) t WHERE v.election_id = p_election GROUP BY t.key ORDER BY t.key LIMIT 10) a), '{}'::jsonb),
    'positions', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'seats', p.seats, 'minSelections', p.min_sel, 'allowAbstain', p.allow_abstain, 'scope', p.scope,
        'eligible', (SELECT count(*) FROM election.voters v WHERE v.election_id = p_election AND (COALESCE((p.scope->>'all')::boolean, false) OR (jsonb_exists(p.scope, 'match') AND v.attrs @> (p.scope->'match')))),
        'candidates', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'platform', c.platform, 'hasPhoto', EXISTS (SELECT 1 FROM election.candidate_photos ph WHERE ph.candidate_id = c.id)) ORDER BY c.name) FROM election.candidates c WHERE c.position_id = p.id), '[]'::jsonb)) ORDER BY p.sort, p.title)
      FROM election.positions p WHERE p.election_id = p_election), '[]'::jsonb)); END$$;

REVOKE ALL ON FUNCTION admin.valid_scope, admin.update_position, admin.update_candidate, admin.set_candidate_photo, admin.clear_candidate_photo, admin.candidate_photo, election.candidate_photo_public, election.candidates_with_photo FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.valid_scope, admin.update_position, admin.update_candidate, admin.set_candidate_photo, admin.clear_candidate_photo, admin.candidate_photo, election.candidate_photo_public, election.candidates_with_photo TO app_api;
