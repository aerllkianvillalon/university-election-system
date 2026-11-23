-- Core voting schema: tenancy, one-ballot-per-round, anonymous insert-only ballots, sealer, verifier.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA org; CREATE SCHEMA election; CREATE SCHEMA participation; CREATE SCHEMA ballots;
DO $$BEGIN CREATE ROLE app_vote NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END$$;

CREATE TABLE org.reserved_org_slugs(slug text PRIMARY KEY);
INSERT INTO org.reserved_org_slugs VALUES ('tgo'),('technogadget');
CREATE TABLE org.organizations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE NOT NULL, name text NOT NULL);
CREATE FUNCTION org.block_reserved() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM org.reserved_org_slugs r WHERE r.slug IN
     (regexp_replace(lower(NEW.slug),'[^a-z0-9]','','g'), regexp_replace(lower(NEW.name),'[^a-z0-9]','','g'))) THEN
    RAISE EXCEPTION 'reserved organization name' USING ERRCODE='check_violation'; END IF;
  RETURN NEW; END$$;
CREATE TRIGGER organizations_reserved BEFORE INSERT OR UPDATE ON org.organizations FOR EACH ROW EXECUTE FUNCTION org.block_reserved();

CREATE TABLE election.elections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES org.organizations,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','CONFIGURED','LOCKED','OPEN','CLOSED','TALLIED','CERTIFIED','ARCHIVED')),
  opens_at timestamptz, closes_at timestamptz, close_grace_seconds int NOT NULL DEFAULT 30,
  frozen boolean NOT NULL DEFAULT false, paused boolean NOT NULL DEFAULT false);
-- exactly one channel per voter per election
CREATE TABLE election.voters(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), election_id uuid NOT NULL REFERENCES election.elections,
  student_id text NOT NULL, channel text NOT NULL CHECK (channel IN ('ONLINE','LAB')), UNIQUE (election_id, student_id));

-- participation: who voted (time truncated to the hour). No ballot reference.
CREATE TABLE participation.participation(election_id uuid NOT NULL, round int NOT NULL DEFAULT 1, voter_id uuid NOT NULL REFERENCES election.voters,
  channel text NOT NULL, hour_bucket timestamptz NOT NULL, request_hash bytea NOT NULL, PRIMARY KEY (election_id, round, voter_id));
-- inbox: what was cast. No voter, no nonce, no timestamp. Receipt is an HMAC the app derives with its own key.
CREATE TABLE ballots.inbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), election_id uuid NOT NULL, round int NOT NULL, receipt bytea NOT NULL, ciphertext bytea NOT NULL);
CREATE TABLE ballots.ballots(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), election_id uuid NOT NULL, round int NOT NULL, chain_id text NOT NULL,
  seq bigint NOT NULL, receipt bytea NOT NULL, ciphertext bytea NOT NULL, prev_hash bytea NOT NULL, entry_hash bytea NOT NULL, UNIQUE (election_id, chain_id, seq));

CREATE FUNCTION ballots.deny_change() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'ballots are insert-only'; END$$;
CREATE TRIGGER ballots_no_ud BEFORE UPDATE OR DELETE ON ballots.ballots FOR EACH ROW EXECUTE FUNCTION ballots.deny_change();
CREATE TRIGGER ballots_no_trunc BEFORE TRUNCATE ON ballots.ballots FOR EACH STATEMENT EXECUTE FUNCTION ballots.deny_change();

-- Length-prefixed canonical encoding for chain hashing (see docs/spec/CHAIN.md to be written).
CREATE FUNCTION ballots.lp(b bytea) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$SELECT int4send(length(b)) || b$$;
CREATE FUNCTION ballots.entry_hash(prev bytea, chain text, bid uuid, ct bytea, s bigint) RETURNS bytea LANGUAGE sql IMMUTABLE AS
$$SELECT digest(ballots.lp(prev)||ballots.lp(convert_to(chain,'UTF8'))||ballots.lp(convert_to(bid::text,'UTF8'))||ballots.lp(ct)||ballots.lp(int8send(s)),'sha256')$$;

-- Central vote transaction: participation + inbox in ONE transaction; the unique key is the final authority.
CREATE FUNCTION ballots.cast_ballot(p_election uuid, p_round int, p_voter uuid, p_request_hash bytea, p_receipt bytea, p_ciphertext bytea)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e election.elections%ROWTYPE; v election.voters%ROWTYPE; n int;
BEGIN
  SELECT * INTO e FROM election.elections WHERE id = p_election;
  IF NOT FOUND OR e.status <> 'OPEN' THEN RETURN 'NOT_OPEN'; END IF;
  IF e.frozen THEN RETURN 'FROZEN'; END IF;
  IF e.paused THEN RETURN 'PAUSED'; END IF;
  IF now() < e.opens_at OR now() > e.closes_at + make_interval(secs => e.close_grace_seconds) THEN RETURN 'CLOSED'; END IF;
  SELECT * INTO v FROM election.voters WHERE id = p_voter AND election_id = p_election;
  IF NOT FOUND THEN RETURN 'NOT_ON_ROLL'; END IF;
  IF v.channel <> 'ONLINE' THEN RETURN 'WRONG_CHANNEL'; END IF;
  INSERT INTO participation.participation(election_id, round, voter_id, channel, hour_bucket, request_hash)
    VALUES (p_election, p_round, p_voter, v.channel, date_trunc('hour', now()), p_request_hash) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    IF EXISTS (SELECT 1 FROM participation.participation WHERE election_id=p_election AND round=p_round AND voter_id=p_voter AND request_hash=p_request_hash)
    THEN RETURN 'DUPLICATE_RETRY'; END IF;
    RETURN 'ALREADY_VOTED';
  END IF;
  INSERT INTO ballots.inbox(election_id, round, receipt, ciphertext) VALUES (p_election, p_round, p_receipt, p_ciphertext);
  RETURN 'RECORDED';
END$$;

-- Sealer: random order, one transaction per ballot (COMMIT), fresh ids, min-batch rule, flush at close.
CREATE PROCEDURE ballots.seal(p_election uuid, p_chain text, p_min_batch int, p_flush boolean)
LANGUAGE plpgsql AS $$
DECLARE r record; prev bytea; s bigint; bid uuid;
BEGIN
  IF NOT p_flush AND (SELECT count(*) FROM ballots.inbox WHERE election_id = p_election) < p_min_batch THEN RETURN; END IF;
  FOR r IN SELECT id FROM ballots.inbox WHERE election_id = p_election ORDER BY random() LOOP
    PERFORM pg_advisory_xact_lock(hashtext(p_election::text || p_chain));
    SELECT entry_hash, seq INTO prev, s FROM ballots.ballots WHERE election_id=p_election AND chain_id=p_chain ORDER BY seq DESC LIMIT 1;
    IF prev IS NULL THEN prev := digest(convert_to(p_chain,'UTF8'),'sha256'); s := 0; END IF;
    bid := gen_random_uuid();
    WITH moved AS (DELETE FROM ballots.inbox WHERE id = r.id RETURNING election_id, round, receipt, ciphertext)
    INSERT INTO ballots.ballots(id, election_id, round, chain_id, seq, receipt, ciphertext, prev_hash, entry_hash)
      SELECT bid, election_id, round, p_chain, s+1, receipt, ciphertext, prev, ballots.entry_hash(prev, p_chain, bid, ciphertext, s+1) FROM moved;
    COMMIT;
  END LOOP;
END$$;

-- Verifier: returns the number of broken links (0 = chain intact).
CREATE FUNCTION ballots.verify_chain(p_election uuid, p_chain text) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE r record; prev bytea := digest(convert_to(p_chain,'UTF8'),'sha256'); s bigint := 0; bad bigint := 0;
BEGIN
  FOR r IN SELECT * FROM ballots.ballots WHERE election_id=p_election AND chain_id=p_chain ORDER BY seq LOOP
    s := s + 1;
    IF r.seq <> s OR r.prev_hash <> prev OR r.entry_hash <> ballots.entry_hash(prev, p_chain, r.id, r.ciphertext, r.seq) THEN bad := bad + 1; END IF;
    prev := r.entry_hash;
  END LOOP;
  RETURN bad;
END$$;

-- Lockdown: RLS on, nothing public, the app role may only call the vote function.
DO $$DECLARE t record; BEGIN
  FOR t IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('org','election','participation','ballots') LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.schemaname, t.tablename);
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC', t.schemaname, t.tablename); END LOOP; END$$;
REVOKE ALL ON FUNCTION ballots.cast_ballot FROM PUBLIC; GRANT USAGE ON SCHEMA ballots TO app_vote; GRANT EXECUTE ON FUNCTION ballots.cast_ballot TO app_vote;
