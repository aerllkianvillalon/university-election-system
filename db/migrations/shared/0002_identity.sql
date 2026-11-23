-- Accounts, vouchers, sessions. Registration is one atomic function with a uniform NULL on any failure.
CREATE SCHEMA identity;
CREATE TABLE identity.vouchers(voter_id uuid PRIMARY KEY REFERENCES election.voters, voucher_hash bytea NOT NULL UNIQUE, expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE TABLE identity.accounts(voter_id uuid PRIMARY KEY REFERENCES election.voters, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE identity.sessions(id_hash bytea PRIMARY KEY, voter_id uuid NOT NULL REFERENCES election.voters, election_id uuid NOT NULL, expires_at timestamptz NOT NULL);
CREATE FUNCTION identity.register(p_election uuid, p_student text, p_voucher_hash bytea, p_password_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE vid uuid;
BEGIN
  SELECT v.id INTO vid FROM election.voters v JOIN identity.vouchers x ON x.voter_id = v.id
   WHERE v.election_id = p_election AND v.student_id = p_student AND x.voucher_hash = p_voucher_hash AND x.used_at IS NULL AND x.expires_at > now()
   FOR UPDATE OF x;
  IF vid IS NULL OR EXISTS (SELECT 1 FROM identity.accounts WHERE voter_id = vid) THEN RETURN NULL; END IF;
  INSERT INTO identity.accounts(voter_id, password_hash) VALUES (vid, p_password_hash);
  UPDATE identity.vouchers SET used_at = now() WHERE voter_id = vid;
  RETURN vid;
END$$;
DO $$DECLARE t record; BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='identity' LOOP
  EXECUTE format('ALTER TABLE identity.%I ENABLE ROW LEVEL SECURITY', t.tablename); EXECUTE format('REVOKE ALL ON identity.%I FROM PUBLIC', t.tablename); END LOOP; END$$;
