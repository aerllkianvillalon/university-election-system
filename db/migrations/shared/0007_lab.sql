-- Lab voting: check-in, session issue/start/cast verified by the LOCAL database. Sessions never reference a ballot, receipt, nonce or inbox row.
CREATE SCHEMA lab;
CREATE FUNCTION election.vote_gate(p_election uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e election.elections%ROWTYPE;
BEGIN SELECT * INTO e FROM election.elections WHERE id = p_election;
  IF NOT FOUND OR e.status <> 'OPEN' THEN RETURN 'NOT_OPEN'; END IF; IF e.frozen THEN RETURN 'FROZEN'; END IF; IF e.paused THEN RETURN 'PAUSED'; END IF;
  IF now() < e.opens_at OR now() > e.closes_at + make_interval(secs => e.close_grace_seconds) THEN RETURN 'WINDOW_CLOSED'; END IF; RETURN NULL; END$$;

CREATE TABLE lab.booths(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), label text NOT NULL, assistive boolean NOT NULL DEFAULT false, enabled boolean NOT NULL DEFAULT true, cert_fingerprint text UNIQUE);
CREATE TABLE lab.voting_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), election_id uuid NOT NULL REFERENCES election.elections, voter_id uuid NOT NULL REFERENCES election.voters,
  booth_id uuid REFERENCES lab.booths, token_hash bytea NOT NULL UNIQUE, status text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','STARTED','SUBMITTED','CANCELLED','EXPIRED')),
  issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, started_at timestamptz, cancel_reason text);
CREATE UNIQUE INDEX one_active_session_per_voter ON lab.voting_sessions(election_id, voter_id) WHERE status IN ('ISSUED','STARTED');
CREATE UNIQUE INDEX one_active_session_per_booth ON lab.voting_sessions(booth_id) WHERE status IN ('ISSUED','STARTED');

CREATE FUNCTION lab.eligibility(p_election uuid, p_voter uuid, p_round int) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE g text; v election.voters%ROWTYPE;
BEGIN g := election.vote_gate(p_election); IF g IS NOT NULL THEN RETURN g; END IF;
  SELECT * INTO v FROM election.voters WHERE id = p_voter AND election_id = p_election; IF NOT FOUND THEN RETURN 'NOT_ON_ROLL'; END IF;
  IF v.channel <> 'LAB' THEN RETURN 'WRONG_CHANNEL'; END IF;
  IF EXISTS (SELECT 1 FROM participation.participation WHERE election_id = p_election AND round = p_round AND voter_id = p_voter) THEN RETURN 'ALREADY_VOTED'; END IF;
  IF EXISTS (SELECT 1 FROM lab.voting_sessions WHERE election_id = p_election AND voter_id = p_voter AND status IN ('ISSUED','STARTED')) THEN RETURN 'SESSION_ACTIVE'; END IF;
  RETURN NULL; END$$;

CREATE FUNCTION lab.check_in(p_election uuid, p_student text, p_round int DEFAULT 1) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE vid uuid; r text;
BEGIN SELECT id INTO vid FROM election.voters WHERE election_id = p_election AND student_id = p_student;
  IF vid IS NULL THEN r := COALESCE(election.vote_gate(p_election), 'NOT_ON_ROLL'); ELSE r := lab.eligibility(p_election, vid, p_round); END IF;
  RETURN CASE WHEN r IS NULL THEN jsonb_build_object('ok', true, 'voter_id', vid) ELSE jsonb_build_object('ok', false, 'reason', r) END; END$$;

CREATE FUNCTION lab.issue_session(p_election uuid, p_voter uuid, p_booth uuid, p_token_hash bytea, p_ttl_secs int DEFAULT 600, p_round int DEFAULT 1) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r text; b lab.booths%ROWTYPE; sid uuid; exp timestamptz := now() + make_interval(secs => p_ttl_secs);
BEGIN r := lab.eligibility(p_election, p_voter, p_round); IF r IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', r); END IF;
  SELECT * INTO b FROM lab.booths WHERE id = p_booth; IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'BOOTH_NOT_REGISTERED'); END IF;
  IF NOT b.enabled THEN RETURN jsonb_build_object('ok', false, 'reason', 'BOOTH_DISABLED'); END IF;
  BEGIN INSERT INTO lab.voting_sessions(election_id, voter_id, booth_id, token_hash, expires_at) VALUES (p_election, p_voter, p_booth, p_token_hash, exp) RETURNING id INTO sid;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', CASE WHEN EXISTS (SELECT 1 FROM lab.voting_sessions WHERE booth_id = p_booth AND status IN ('ISSUED','STARTED')) THEN 'BOOTH_BUSY' ELSE 'SESSION_ACTIVE' END);
  END;
  RETURN jsonb_build_object('ok', true, 'session_id', sid, 'expires_at', exp); END$$;

CREATE FUNCTION lab.cancel_session(p_session uuid, p_reason text) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH u AS (UPDATE lab.voting_sessions SET status = 'CANCELLED', cancel_reason = p_reason WHERE id = p_session AND status IN ('ISSUED','STARTED') RETURNING 1) SELECT EXISTS (SELECT 1 FROM u) $$;

CREATE FUNCTION lab.start_session(p_token_hash bytea, p_booth uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s lab.voting_sessions%ROWTYPE; g text;
BEGIN SELECT * INTO s FROM lab.voting_sessions WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_SESSION'); END IF;
  IF s.status = 'CANCELLED' THEN RETURN jsonb_build_object('ok', false, 'reason', 'CANCELLED'); END IF;
  IF s.status = 'EXPIRED' THEN RETURN jsonb_build_object('ok', false, 'reason', 'EXPIRED'); END IF;
  IF s.status <> 'ISSUED' THEN RETURN jsonb_build_object('ok', false, 'reason', 'REUSED'); END IF;
  IF s.booth_id IS DISTINCT FROM p_booth THEN RETURN jsonb_build_object('ok', false, 'reason', 'WRONG_BOOTH'); END IF;
  IF s.expires_at < now() THEN UPDATE lab.voting_sessions SET status = 'EXPIRED' WHERE id = s.id; RETURN jsonb_build_object('ok', false, 'reason', 'EXPIRED'); END IF;
  g := election.vote_gate(s.election_id); IF g IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', g); END IF;
  UPDATE lab.voting_sessions SET status = 'STARTED', started_at = now() WHERE id = s.id;
  RETURN jsonb_build_object('ok', true, 'election_id', s.election_id, 'voter_id', s.voter_id, 'expires_at', s.expires_at); END$$;

-- Lab vote: participation + inbox in one transaction; the session is then closed with booth and minute-level time erased.
CREATE FUNCTION lab.cast_ballot(p_token_hash bytea, p_booth uuid, p_round int, p_receipt bytea, p_ciphertext bytea) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s lab.voting_sessions%ROWTYPE; g text; n int;
BEGIN SELECT * INTO s FROM lab.voting_sessions WHERE token_hash = p_token_hash FOR UPDATE; IF NOT FOUND THEN RETURN 'INVALID_SESSION'; END IF;
  IF s.status = 'CANCELLED' THEN RETURN 'CANCELLED'; END IF; IF s.status = 'EXPIRED' THEN RETURN 'EXPIRED'; END IF;
  IF s.status <> 'STARTED' THEN RETURN CASE s.status WHEN 'SUBMITTED' THEN 'REUSED' ELSE 'NOT_STARTED' END; END IF;
  IF s.booth_id IS DISTINCT FROM p_booth THEN RETURN 'WRONG_BOOTH'; END IF;
  IF s.expires_at < now() THEN UPDATE lab.voting_sessions SET status = 'EXPIRED' WHERE id = s.id; RETURN 'EXPIRED'; END IF;
  g := election.vote_gate(s.election_id); IF g IS NOT NULL THEN RETURN g; END IF;
  INSERT INTO participation.participation(election_id, round, voter_id, channel, hour_bucket, request_hash) VALUES (s.election_id, p_round, s.voter_id, 'LAB', date_trunc('hour', now()), gen_random_bytes(32)) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN UPDATE lab.voting_sessions SET status = 'CANCELLED', cancel_reason = 'ALREADY_VOTED' WHERE id = s.id; RETURN 'ALREADY_VOTED'; END IF;
  INSERT INTO ballots.inbox(election_id, round, receipt, ciphertext) VALUES (s.election_id, p_round, p_receipt, p_ciphertext);
  UPDATE lab.voting_sessions SET status = 'SUBMITTED', booth_id = NULL, issued_at = date_trunc('hour', issued_at), started_at = NULL WHERE id = s.id;
  RETURN 'RECORDED'; END$$;

CREATE FUNCTION lab.booth_for_cert(p_fp text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$SELECT id FROM lab.booths WHERE cert_fingerprint = p_fp AND enabled$$;
DO $$DECLARE t record; BEGIN FOR t IN SELECT tablename n FROM pg_tables WHERE schemaname='lab' LOOP
  EXECUTE format('ALTER TABLE lab.%I ENABLE ROW LEVEL SECURITY', t.n); EXECUTE format('REVOKE ALL ON lab.%I FROM PUBLIC', t.n); END LOOP; END$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lab FROM PUBLIC; REVOKE ALL ON FUNCTION election.vote_gate FROM PUBLIC;
GRANT USAGE ON SCHEMA lab TO app_api; GRANT EXECUTE ON FUNCTION lab.check_in, lab.issue_session, lab.cancel_session, lab.start_session, lab.cast_ballot, lab.booth_for_cert TO app_api;
