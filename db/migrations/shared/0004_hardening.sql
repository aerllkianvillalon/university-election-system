-- Rate limits, forgot/reset password, email outbox. Reset tokens are stored hashed, single-use, 15 minutes, redeemed by POST only.
CREATE SCHEMA security; CREATE SCHEMA ops;
CREATE UNLOGGED TABLE security.rate_limits(key text PRIMARY KEY, n int NOT NULL, window_start timestamptz NOT NULL);
CREATE FUNCTION security.hit(p_key text, p_limit int, p_secs int) RETURNS boolean LANGUAGE sql AS $$
  INSERT INTO security.rate_limits AS r(key, n, window_start) VALUES (p_key, 1, now())
  ON CONFLICT (key) DO UPDATE SET
    n = CASE WHEN r.window_start < now() - make_interval(secs => p_secs) THEN 1 ELSE r.n + 1 END,
    window_start = CASE WHEN r.window_start < now() - make_interval(secs => p_secs) THEN now() ELSE r.window_start END
  RETURNING n <= p_limit $$;
ALTER TABLE election.voters ADD COLUMN roll_email text;       -- the registrar's email; voters can never change it
ALTER TABLE identity.accounts ADD COLUMN disputed boolean NOT NULL DEFAULT false;
CREATE TABLE identity.reset_tokens(token_hash bytea PRIMARY KEY, voter_id uuid NOT NULL REFERENCES election.voters, expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE TABLE ops.outbox(id bigserial PRIMARY KEY, to_email text NOT NULL, subject text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz);

CREATE FUNCTION identity.start_reset(p_election uuid, p_student text, p_token_hash bytea, p_body text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v election.voters%ROWTYPE;
BEGIN
  SELECT v2.* INTO v FROM election.voters v2 JOIN identity.accounts a ON a.voter_id = v2.id
   WHERE v2.election_id = p_election AND v2.student_id = p_student AND NOT a.disputed AND v2.roll_email IS NOT NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE identity.reset_tokens SET used_at = now() WHERE voter_id = v.id AND used_at IS NULL;
  INSERT INTO identity.reset_tokens VALUES (p_token_hash, v.id, now() + interval '15 minutes', NULL);
  INSERT INTO ops.outbox(to_email, subject, body) VALUES (v.roll_email, 'Reset your voting password', p_body);
  RETURN true;
END$$;
CREATE FUNCTION identity.redeem_reset(p_token_hash bytea, p_password_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE vid uuid;
BEGIN
  SELECT voter_id INTO vid FROM identity.reset_tokens WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now() FOR UPDATE;
  IF vid IS NULL OR EXISTS (SELECT 1 FROM identity.accounts WHERE voter_id = vid AND disputed) THEN RETURN false; END IF;
  UPDATE identity.accounts SET password_hash = p_password_hash WHERE voter_id = vid;
  UPDATE identity.reset_tokens SET used_at = now() WHERE token_hash = p_token_hash;
  DELETE FROM identity.sessions WHERE voter_id = vid;      -- revoke every session
  RETURN true;
END$$;
DO $$DECLARE t record; BEGIN FOR t IN SELECT schemaname s, tablename n FROM pg_tables WHERE schemaname IN ('security','ops') OR (schemaname='identity' AND tablename='reset_tokens') LOOP
  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.s, t.n); EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC', t.s, t.n); END LOOP; END$$;
