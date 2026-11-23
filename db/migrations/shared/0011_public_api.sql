-- Read-only helpers for the voter-facing API: public election info (no counts), "have I voted", receipt status.
CREATE FUNCTION election.public_info(p_election uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('id', e.id, 'organization', o.name, 'status', e.status, 'paused', e.paused, 'frozen', e.frozen, 'opensAt', e.opens_at, 'closesAt', e.closes_at)
    FROM election.elections e JOIN org.organizations o ON o.id = e.org_id WHERE e.id = p_election $$;
CREATE FUNCTION election.has_voted(p_election uuid, p_voter uuid, p_round int) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM participation.participation WHERE election_id = p_election AND voter_id = p_voter AND round = p_round) $$;
-- The receipt is an HMAC only the voter holds; this reveals whether it exists and whether it is sealed in a chain, never who cast it.
CREATE FUNCTION ballots.receipt_status(p_election uuid, p_receipt bytea) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM ballots.ballots WHERE election_id = p_election AND receipt = p_receipt) THEN 'sealed'
              WHEN EXISTS (SELECT 1 FROM ballots.inbox WHERE election_id = p_election AND receipt = p_receipt) THEN 'recorded' END $$;
REVOKE ALL ON FUNCTION election.public_info, election.has_voted, ballots.receipt_status FROM PUBLIC;
GRANT EXECUTE ON FUNCTION election.public_info, election.has_voted, ballots.receipt_status TO app_api;
