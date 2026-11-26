-- Course / year / section pick at registration.
-- The pick never decides what a voter may vote on (the roll does). It is checked against the roll, so a wrong pick fails like any other bad registration.
CREATE FUNCTION election.public_choices(p_election uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(jsonb_object_agg(k, vals), '{}'::jsonb) FROM (
    SELECT t.key AS k, (array_agg(DISTINCT t.value ORDER BY t.value))[1:60] AS vals
      FROM election.voters v, jsonb_each_text(v.attrs) t
     WHERE v.election_id = p_election AND t.key IN ('program','year','section') AND length(t.value) BETWEEN 1 AND 40
     GROUP BY t.key) a
$$;
CREATE FUNCTION identity.register_checked(p_election uuid, p_student text, p_voucher_hash bytea, p_password_hash text, p_claims jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c jsonb := '{}'::jsonb; k text;
BEGIN
  IF p_claims IS NOT NULL AND jsonb_typeof(p_claims) = 'object' THEN
    FOREACH k IN ARRAY ARRAY['program','year','section'] LOOP
      IF jsonb_exists(p_claims, k) AND jsonb_typeof(p_claims->k) = 'string' THEN c := c || jsonb_build_object(k, p_claims->k); END IF;
    END LOOP;
  END IF;
  IF c <> '{}'::jsonb AND NOT EXISTS (SELECT 1 FROM election.voters v WHERE v.election_id = p_election AND v.student_id = p_student AND v.attrs @> c) THEN RETURN NULL; END IF;
  RETURN identity.register(p_election, p_student, p_voucher_hash, p_password_hash);
END$$;
REVOKE ALL ON FUNCTION election.public_choices, identity.register_checked FROM PUBLIC;
GRANT EXECUTE ON FUNCTION election.public_choices, identity.register_checked TO app_api;
