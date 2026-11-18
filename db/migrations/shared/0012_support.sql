-- Support forms: protests, account disputes, fake-site reports (recorded for staff) and in-person claim codes.
-- Design rules: the public forms only RECORD; they never change an account (otherwise anyone could lock out anyone).
-- Staff act: issuing a claim code is the one step that marks an account disputed, and redeeming it clears the flag.
-- app_api reads none of these tables; it can only call the functions granted at the bottom.
CREATE SCHEMA support;
CREATE TABLE support.requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ref text NOT NULL UNIQUE,
  election_id uuid NOT NULL REFERENCES election.elections,
  kind text NOT NULL CHECK (kind IN ('protest','dispute','report')),
  student_id text CHECK (length(student_id) <= 32), subject text CHECK (length(subject) <= 200),
  details text NOT NULL DEFAULT '' CHECK (length(details) <= 4000), url text CHECK (length(url) <= 2000),
  on_roll boolean NOT NULL DEFAULT false,            -- staff see whether the Student ID exists; the filer is never told
  session_verified boolean NOT NULL DEFAULT false,   -- true only if the filer was signed in as that Student ID
  status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','IN_REVIEW','RESOLVED','DISMISSED')),
  note text CHECK (length(note) <= 2000), handled_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz);
CREATE INDEX ON support.requests(election_id, status, created_at DESC);
CREATE TABLE identity.claim_codes(
  voter_id uuid PRIMARY KEY REFERENCES election.voters,   -- one live code per voter; issuing again replaces it
  code_hash bytea NOT NULL UNIQUE, issued_by uuid, issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, used_at timestamptz);
ALTER TABLE support.requests ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.claim_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON support.requests, identity.claim_codes FROM PUBLIC;

-- Public: record a protest, dispute or report. Returns 'ok', 'NO_ELECTION', or 'DUPLICATE_REF' (caller retries with a new reference).
CREATE FUNCTION support.file(p_election uuid, p_kind text, p_student text, p_subject text, p_details text, p_url text, p_ref text, p_session_voter uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM election.elections WHERE id = p_election) THEN RETURN 'NO_ELECTION'; END IF;
  INSERT INTO support.requests(ref, election_id, kind, student_id, subject, details, url, on_roll, session_verified)
  VALUES (p_ref, p_election, p_kind, p_student, p_subject, coalesce(p_details, ''), p_url,
    p_student IS NOT NULL AND EXISTS (SELECT 1 FROM election.voters WHERE election_id = p_election AND student_id = p_student),
    p_student IS NOT NULL AND p_session_voter IS NOT NULL AND EXISTS (SELECT 1 FROM election.voters WHERE id = p_session_voter AND election_id = p_election AND student_id = p_student));
  RETURN 'ok';
EXCEPTION WHEN unique_violation THEN RETURN 'DUPLICATE_REF';
END$$;

-- Public: redeem an in-person claim code. Sets the password (creating or replacing the account), clears the dispute flag,
-- ends every session and cancels pending reset links. One generic false for every failure.
CREATE FUNCTION identity.redeem_claim(p_election uuid, p_student text, p_code_hash bytea, p_password_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE vid uuid;
BEGIN
  SELECT c.voter_id INTO vid FROM identity.claim_codes c JOIN election.voters v ON v.id = c.voter_id JOIN election.elections e ON e.id = v.election_id
   WHERE v.election_id = p_election AND v.student_id = p_student AND c.code_hash = p_code_hash AND c.used_at IS NULL AND c.expires_at > now()
     AND e.status NOT IN ('CLOSED','TALLIED','CERTIFIED','ARCHIVED') FOR UPDATE OF c;
  IF vid IS NULL THEN RETURN false; END IF;
  INSERT INTO identity.accounts(voter_id, password_hash) VALUES (vid, p_password_hash)
    ON CONFLICT (voter_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, disputed = false;
  UPDATE identity.claim_codes SET used_at = now() WHERE voter_id = vid;
  UPDATE identity.reset_tokens SET used_at = now() WHERE voter_id = vid AND used_at IS NULL;
  DELETE FROM identity.sessions WHERE voter_id = vid;
  INSERT INTO ops.audit(election_id, action, detail) VALUES (p_election, 'CLAIM_REDEEMED', jsonb_build_object('voter_id', vid));
  RETURN true;
END$$;

-- Staff (same organization only).
CREATE FUNCTION admin.issue_claim_code(p_election uuid, p_staff uuid, p_student text, p_hash bytea, p_days int) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE vid uuid;
BEGIN
  IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT v.id INTO vid FROM election.voters v JOIN election.elections e ON e.id = v.election_id
   WHERE v.election_id = p_election AND v.student_id = p_student AND v.channel = 'ONLINE' AND e.status NOT IN ('CLOSED','TALLIED','CERTIFIED','ARCHIVED');
  IF vid IS NULL THEN RETURN false; END IF;
  INSERT INTO identity.claim_codes(voter_id, code_hash, issued_by, expires_at) VALUES (vid, p_hash, p_staff, now() + make_interval(days => p_days))
    ON CONFLICT (voter_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, issued_by = EXCLUDED.issued_by, issued_at = now(), expires_at = EXCLUDED.expires_at, used_at = NULL;
  DELETE FROM security.rate_limits WHERE key = 'claim:' || p_election::text || ':' || p_student;   -- staff are in front of the student: a lockout caused by someone else's wrong guesses ends here
  UPDATE identity.accounts SET disputed = true WHERE voter_id = vid;     -- whoever holds the account now cannot reset it until the claim is done
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, p_election, 'CLAIM_CODE_ISSUED', jsonb_build_object('voter_id', vid));
  RETURN true;
END$$;
CREATE FUNCTION admin.list_support(p_election uuid, p_staff uuid, p_status text, p_kind text)
RETURNS TABLE(id uuid, ref text, kind text, student_id text, subject text, details text, url text, on_roll boolean, session_verified boolean, status text, note text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  RETURN QUERY SELECT r.id, r.ref, r.kind, r.student_id, r.subject, r.details, r.url, r.on_roll, r.session_verified, r.status, r.note, r.created_at
    FROM support.requests r WHERE r.election_id = p_election AND (p_status IS NULL OR r.status = p_status) AND (p_kind IS NULL OR r.kind = p_kind)
    ORDER BY r.created_at DESC LIMIT 200; END$$;
CREATE FUNCTION admin.update_support(p_id uuid, p_staff uuid, p_status text, p_note text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE eid uuid;
BEGIN SELECT election_id INTO eid FROM support.requests WHERE id = p_id;
  IF eid IS NULL OR NOT admin.same_org(eid, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;   -- unknown id and other-org id look the same
  UPDATE support.requests SET status = p_status, note = p_note, handled_by = p_staff, updated_at = now() WHERE id = p_id;
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_staff, eid, 'SUPPORT_' || p_status, jsonb_build_object('request_id', p_id));
  RETURN true; END$$;

REVOKE ALL ON FUNCTION support.file, identity.redeem_claim, admin.issue_claim_code, admin.list_support, admin.update_support FROM PUBLIC;
GRANT USAGE ON SCHEMA support TO app_api;
GRANT EXECUTE ON FUNCTION support.file, identity.redeem_claim, admin.issue_claim_code, admin.list_support, admin.update_support TO app_api;
