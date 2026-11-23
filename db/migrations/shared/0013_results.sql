-- Results: a signing key registered before opening, signed tallies imported against the sealed chain, two-admin certification, public results.
-- Trust model: Postgres cannot verify Ed25519, so the API verifies the signature against election.signing_key and this file checks every fact it CAN
-- check about the database (chain length and tip, empty inbox, ids and bounds). The signed bodies are then published so anyone can re-verify offline.
ALTER TABLE election.elections ADD COLUMN signing_key bytea CHECK (signing_key IS NULL OR length(signing_key) = 32), ADD COLUMN certified_at timestamptz;

CREATE TABLE election.result_sets(
  election_id uuid NOT NULL REFERENCES election.elections, chain_id text NOT NULL,
  body text NOT NULL, signature bytea NOT NULL CHECK (length(signature) = 64),     -- exactly what the offline tool signed
  ballots bigint NOT NULL CHECK (ballots >= 0), chain_tip bytea, counts jsonb NOT NULL,
  imported_by uuid, imported_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (election_id, chain_id));
ALTER TABLE election.result_sets ENABLE ROW LEVEL SECURITY; REVOKE ALL ON election.result_sets FROM PUBLIC;
-- A result set is evidence: it may be added, never changed or removed.
CREATE FUNCTION election.deny_result_change() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'result sets are insert-only'; END$$;
CREATE TRIGGER result_sets_insert_only BEFORE UPDATE OR DELETE ON election.result_sets FOR EACH ROW EXECUTE FUNCTION election.deny_result_change();

-- certify joins the two-admin actions
DO $$ DECLARE c text; BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'admin.approvals'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%unfreeze%';
  EXECUTE format('ALTER TABLE admin.approvals DROP CONSTRAINT %I', c); END $$;
ALTER TABLE admin.approvals ADD CONSTRAINT approvals_action_check CHECK (action IN ('lock','open','pause','resume','extend','close','unfreeze','certify'));

CREATE OR REPLACE FUNCTION admin.gate(p_election uuid, p_action text, p_params jsonb) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e election.elections%ROWTYPE; ch record; rs election.result_sets%ROWTYPE;
BEGIN
  SELECT * INTO e FROM election.elections WHERE id = p_election; IF NOT FOUND THEN RETURN 'NO_ELECTION'; END IF;
  IF p_action = 'lock' THEN
    IF e.status NOT IN ('DRAFT','CONFIGURED') THEN RETURN 'BAD_STATE'; END IF;
    IF NOT EXISTS (SELECT 1 FROM election.positions WHERE election_id = p_election) THEN RETURN 'NO_POSITIONS'; END IF;
    IF EXISTS (SELECT 1 FROM election.positions p WHERE p.election_id = p_election AND NOT EXISTS (SELECT 1 FROM election.candidates c WHERE c.position_id = p.id)) THEN RETURN 'POSITION_WITHOUT_CANDIDATES'; END IF;
    IF NOT EXISTS (SELECT 1 FROM election.voters WHERE election_id = p_election) THEN RETURN 'NO_VOTERS'; END IF;
  ELSIF p_action = 'open' THEN
    IF e.status <> 'LOCKED' THEN RETURN 'BAD_STATE'; END IF;
    IF e.public_key IS NULL THEN RETURN 'NO_ELECTION_KEY'; END IF;
    IF e.signing_key IS NULL THEN RETURN 'NO_SIGNING_KEY'; END IF;     -- results could never be verified without it
    IF e.opens_at IS NULL OR e.closes_at IS NULL OR e.closes_at <= e.opens_at THEN RETURN 'NO_WINDOW'; END IF;
  ELSIF p_action = 'pause' THEN IF e.status <> 'OPEN' OR e.paused THEN RETURN 'BAD_STATE'; END IF;
  ELSIF p_action = 'resume' THEN IF NOT e.paused THEN RETURN 'BAD_STATE'; END IF; IF e.frozen THEN RETURN 'FROZEN'; END IF;
  ELSIF p_action = 'extend' THEN IF e.status <> 'OPEN' THEN RETURN 'BAD_STATE'; END IF;
    IF COALESCE((p_params->>'minutes')::int, 0) NOT BETWEEN 1 AND 1440 THEN RETURN 'EXTENSION_CAP'; END IF;
  ELSIF p_action = 'close' THEN IF e.status <> 'OPEN' THEN RETURN 'BAD_STATE'; END IF;
  ELSIF p_action = 'unfreeze' THEN IF NOT e.frozen THEN RETURN 'BAD_STATE'; END IF;
  ELSIF p_action = 'certify' THEN
    IF e.status <> 'TALLIED' THEN RETURN 'BAD_STATE'; END IF;
    IF EXISTS (SELECT 1 FROM ballots.inbox WHERE election_id = p_election) THEN RETURN 'UNSEALED_BALLOTS'; END IF;
    IF NOT EXISTS (SELECT 1 FROM election.result_sets WHERE election_id = p_election) THEN RETURN 'RESULTS_MISSING'; END IF;
    FOR ch IN SELECT chain_id, count(*) AS n FROM ballots.ballots WHERE election_id = p_election GROUP BY chain_id LOOP   -- every chain that holds ballots must be covered
      IF ballots.verify_chain(p_election, ch.chain_id) <> 0 THEN RETURN 'CHAIN_BROKEN'; END IF;
      SELECT * INTO rs FROM election.result_sets WHERE election_id = p_election AND chain_id = ch.chain_id;
      IF NOT FOUND THEN RETURN 'RESULTS_MISSING'; END IF;
      IF rs.ballots <> ch.n OR rs.chain_tip IS DISTINCT FROM (SELECT entry_hash FROM ballots.ballots WHERE election_id = p_election AND chain_id = ch.chain_id ORDER BY seq DESC LIMIT 1) THEN RETURN 'RESULTS_STALE'; END IF;
    END LOOP;
    IF (SELECT coalesce(sum(ballots), 0) FROM election.result_sets WHERE election_id = p_election) <> (SELECT count(*) FROM participation.participation WHERE election_id = p_election) THEN RETURN 'PARTICIPATION_MISMATCH'; END IF;
  END IF;
  RETURN NULL;
END$$;

CREATE OR REPLACE FUNCTION admin.approve(p_approval uuid, p_admin uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a admin.approvals%ROWTYPE; r text;
BEGIN
  SELECT * INTO a FROM admin.approvals WHERE id = p_approval AND executed_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF a.initiator = p_admin THEN RAISE EXCEPTION 'SAME_ADMIN'; END IF;
  IF NOT admin.same_org(a.election_id, p_admin) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  r := admin.gate(a.election_id, a.action, a.params); IF r IS NOT NULL THEN RAISE EXCEPTION 'GATE:%', r; END IF;   -- checked again now, not only when requested
  UPDATE election.elections SET
    status = CASE a.action WHEN 'lock' THEN 'LOCKED' WHEN 'open' THEN 'OPEN' WHEN 'close' THEN 'CLOSED' WHEN 'certify' THEN 'CERTIFIED' ELSE status END,
    certified_at = CASE a.action WHEN 'certify' THEN now() ELSE certified_at END,
    paused = CASE a.action WHEN 'pause' THEN true WHEN 'resume' THEN false ELSE paused END,
    closes_at = CASE a.action WHEN 'extend' THEN closes_at + make_interval(mins => (a.params->>'minutes')::int) ELSE closes_at END,
    frozen = CASE a.action WHEN 'unfreeze' THEN false ELSE frozen END,
    freeze_started_at = CASE a.action WHEN 'unfreeze' THEN NULL ELSE freeze_started_at END,
    freeze_by = CASE a.action WHEN 'unfreeze' THEN NULL ELSE freeze_by END, freeze_ratified_by = CASE a.action WHEN 'unfreeze' THEN NULL ELSE freeze_ratified_by END
   WHERE id = a.election_id;
  UPDATE admin.approvals SET approver = p_admin, executed_at = now() WHERE id = p_approval;
  IF a.action = 'certify' THEN INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_admin, a.election_id, 'CERTIFIED', jsonb_build_object('initiator', a.initiator, 'approver', p_admin)); END IF;
END$$;

-- Readiness gains the signing key (everything else is unchanged).
CREATE OR REPLACE FUNCTION admin.readiness(p_election uuid, p_staff uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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
    jsonb_build_object('name','signing_key_set','ok',e.signing_key IS NOT NULL,'detail',''),
    jsonb_build_object('name','window_set','ok',e.opens_at IS NOT NULL AND e.closes_at > e.opens_at,'detail',''),
    jsonb_build_object('name','online_voters_have_vouchers','ok',nm = 0,'detail',nm || ' without a voucher'),
    jsonb_build_object('name','lab_booths_registered','ok',nl = 0 OR nb > 0,'detail',nb || ' enabled booths for ' || nl || ' lab voters'),
    jsonb_build_object('name','chain_verifies','ok',bad = 0,'detail',bad || ' broken links'));
  SELECT bool_and((c->>'ok')::boolean) INTO ok FROM jsonb_array_elements(chk) c;
  RETURN jsonb_build_object('ready', ok, 'checks', chk); END$$;

-- Public election info now carries both key fingerprints, so anyone can compare them with the ones read aloud at the key ceremony.
CREATE OR REPLACE FUNCTION election.public_info(p_election uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('id', e.id, 'organization', o.name, 'status', e.status, 'paused', e.paused, 'frozen', e.frozen, 'opensAt', e.opens_at, 'closesAt', e.closes_at,
    'electionKeyFingerprint', left(encode(sha256(e.public_key), 'hex'), 16), 'signingKeyFingerprint', left(encode(sha256(e.signing_key), 'hex'), 16))
    FROM election.elections e JOIN org.organizations o ON o.id = e.org_id WHERE e.id = p_election $$;

CREATE FUNCTION admin.set_signing_key(p_election uuid, p_staff uuid, p_key bytea) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p_key IS NULL OR length(p_key) <> 32 THEN RAISE EXCEPTION 'GATE:BAD_KEY'; END IF;
  UPDATE election.elections SET signing_key = p_key WHERE id = p_election AND status IN ('DRAFT','CONFIGURED','LOCKED'); IF NOT FOUND THEN RAISE EXCEPTION 'GATE:BAD_STATE'; END IF;   -- never after voting starts
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'SIGNING_KEY_SET', jsonb_build_object('fingerprint', encode(sha256(p_key), 'hex'))); END$$;
CREATE FUNCTION admin.signing_key_of(p_election uuid, p_staff uuid) RETURNS bytea LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF; RETURN (SELECT signing_key FROM election.elections WHERE id = p_election); END$$;

-- Import one signed tally (one chain). The signature was verified by the API; everything about the database is checked here.
CREATE FUNCTION admin.import_results(p_election uuid, p_staff uuid, p_chain text, p_body text, p_signature bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e election.elections%ROWTYPE; b jsonb; n bigint; tip bytea; k record; c record; seats int; ab bigint; v bigint; csum bigint;
BEGIN
  IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT * INTO e FROM election.elections WHERE id = p_election FOR UPDATE;
  IF e.status NOT IN ('CLOSED','TALLIED') THEN RAISE EXCEPTION 'GATE:BAD_STATE'; END IF;
  IF EXISTS (SELECT 1 FROM ballots.inbox WHERE election_id = p_election) THEN RAISE EXCEPTION 'GATE:UNSEALED_BALLOTS'; END IF;
  IF ballots.verify_chain(p_election, p_chain) <> 0 THEN RAISE EXCEPTION 'GATE:CHAIN_BROKEN'; END IF;
  SELECT count(*) INTO n FROM ballots.ballots WHERE election_id = p_election AND chain_id = p_chain;
  SELECT entry_hash INTO tip FROM ballots.ballots WHERE election_id = p_election AND chain_id = p_chain ORDER BY seq DESC LIMIT 1;
  IF n = 0 AND p_chain <> 'main' THEN RAISE EXCEPTION 'GATE:RESULTS_MISMATCH'; END IF;
  BEGIN
    b := p_body::jsonb;
    IF b->>'chain' IS DISTINCT FROM p_chain OR (b->>'ballots')::bigint <> n OR coalesce(b->>'chainTip', '') <> coalesce(encode(tip, 'hex'), '') THEN RAISE EXCEPTION 'GATE:RESULTS_MISMATCH'; END IF;
    IF jsonb_typeof(b->'counts') <> 'object' THEN RAISE EXCEPTION 'GATE:RESULTS_INVALID'; END IF;
    FOR k IN SELECT key, value FROM jsonb_each(b->'counts') LOOP
      SELECT p.seats INTO seats FROM election.positions p WHERE p.id = k.key::uuid AND p.election_id = p_election;
      IF NOT FOUND OR jsonb_typeof(k.value->'abstain') <> 'number' OR jsonb_typeof(k.value->'candidates') <> 'object' THEN RAISE EXCEPTION 'GATE:RESULTS_INVALID'; END IF;
      ab := (k.value->>'abstain')::bigint; csum := 0;
      IF ab < 0 OR ab > n THEN RAISE EXCEPTION 'GATE:RESULTS_INVALID'; END IF;
      FOR c IN SELECT key, value FROM jsonb_each(k.value->'candidates') LOOP
        IF NOT EXISTS (SELECT 1 FROM election.candidates x WHERE x.id = c.key::uuid AND x.position_id = k.key::uuid) OR jsonb_typeof(c.value) <> 'number' THEN RAISE EXCEPTION 'GATE:RESULTS_INVALID'; END IF;
        v := (c.value)::text::bigint; IF v < 0 OR v > n - ab THEN RAISE EXCEPTION 'GATE:RESULTS_INVALID'; END IF;   -- someone who abstained did not vote for a candidate
        csum := csum + v;
      END LOOP;
      IF csum > seats * (n - ab) THEN RAISE EXCEPTION 'GATE:RESULTS_INVALID'; END IF;   -- nobody may name more candidates than there are seats
    END LOOP;
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'GATE:%' THEN RAISE; ELSE RAISE EXCEPTION 'GATE:RESULTS_INVALID'; END IF;   -- bad JSON, bad uuid, bad number
  END;
  BEGIN INSERT INTO election.result_sets(election_id, chain_id, body, signature, ballots, chain_tip, counts, imported_by) VALUES (p_election, p_chain, p_body, p_signature, n, tip, b->'counts', p_staff);
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'GATE:ALREADY_IMPORTED'; END;
  UPDATE election.elections SET status = 'TALLIED' WHERE id = p_election;
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'RESULTS_IMPORTED', jsonb_build_object('chain', p_chain, 'ballots', n));
  RETURN jsonb_build_object('chain', p_chain, 'ballots', n, 'status', 'TALLIED');
END$$;

-- Staff view: what is imported, what is still missing, and why certification is or is not possible.
CREATE FUNCTION admin.results_status(p_election uuid, p_staff uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  RETURN jsonb_build_object('status', (SELECT status FROM election.elections WHERE id = p_election),
    'inbox', (SELECT count(*) FROM ballots.inbox WHERE election_id = p_election),
    'participation', (SELECT count(*) FROM participation.participation WHERE election_id = p_election),
    'chains', coalesce((SELECT jsonb_agg(jsonb_build_object('chain', ch.chain_id, 'ballots', ch.n, 'imported', rs.chain_id IS NOT NULL,
        'matches', rs.chain_id IS NOT NULL AND rs.ballots = ch.n) ORDER BY ch.chain_id)
      FROM (SELECT chain_id, count(*) AS n FROM ballots.ballots WHERE election_id = p_election GROUP BY chain_id) ch
      LEFT JOIN election.result_sets rs ON rs.election_id = p_election AND rs.chain_id = ch.chain_id), '[]'),
    'certifyBlocker', admin.gate(p_election, 'certify', '{}')); END$$;

-- Public: nothing until certified; then counts per candidate plus the signed bodies, so the counts can be re-verified independently.
CREATE FUNCTION election.public_results(p_election uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e election.elections%ROWTYPE;
BEGIN SELECT * INTO e FROM election.elections WHERE id = p_election; IF NOT FOUND THEN RETURN NULL; END IF;
  IF e.status NOT IN ('CERTIFIED','ARCHIVED') THEN RETURN jsonb_build_object('published', false, 'status', e.status); END IF;
  RETURN jsonb_build_object('published', true, 'status', e.status, 'certifiedAt', e.certified_at,
    'ballots', (SELECT coalesce(sum(ballots), 0) FROM election.result_sets WHERE election_id = p_election),
    'signingKey', encode(e.signing_key, 'base64'), 'signingKeyFingerprint', left(encode(sha256(e.signing_key), 'hex'), 16),
    'sets', coalesce((SELECT jsonb_agg(jsonb_build_object('chain', chain_id, 'ballots', ballots, 'chainTip', encode(chain_tip, 'hex'), 'body', body, 'signature', translate(encode(signature, 'base64'), E'\n', '')) ORDER BY chain_id)
                      FROM election.result_sets WHERE election_id = p_election), '[]'),
    'contests', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'seats', p.seats,
        'abstain', (SELECT coalesce(sum((rs.counts->(p.id::text)->>'abstain')::bigint), 0) FROM election.result_sets rs WHERE rs.election_id = p_election),
        'candidates', coalesce((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'votes', t.votes) ORDER BY t.votes DESC, t.name)
            FROM (SELECT c.id, c.name, (SELECT coalesce(sum((rs.counts->(p.id::text)->'candidates'->>(c.id::text))::bigint), 0) FROM election.result_sets rs WHERE rs.election_id = p_election) AS votes
                    FROM election.candidates c WHERE c.position_id = p.id) t), '[]')) ORDER BY p.sort)
      FROM election.positions p WHERE p.election_id = p_election), '[]')); END$$;

REVOKE ALL ON FUNCTION election.deny_result_change, admin.set_signing_key, admin.signing_key_of, admin.import_results, admin.results_status, election.public_results FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.set_signing_key, admin.signing_key_of, admin.import_results, admin.results_status, election.public_results TO app_api;
