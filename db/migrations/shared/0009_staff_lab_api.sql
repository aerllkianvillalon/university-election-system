-- Staff accounts (admin/proctor/observer) with password + TOTP, staff sessions, and the SQL surface the lab/admin HTTP layer needs.
ALTER TABLE admin.admins ADD COLUMN username text UNIQUE, ADD COLUMN role text NOT NULL DEFAULT 'ADMIN' CHECK (role IN ('ADMIN','PROCTOR','OBSERVER')),
  ADD COLUMN password_hash text, ADD COLUMN totp_secret bytea, ADD COLUMN totp_last_step bigint NOT NULL DEFAULT 0;
CREATE TABLE admin.staff_sessions(id_hash bytea PRIMARY KEY, staff_id uuid NOT NULL REFERENCES admin.admins, mfa_verified boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL);
ALTER TABLE admin.staff_sessions ENABLE ROW LEVEL SECURITY; REVOKE ALL ON admin.staff_sessions FROM PUBLIC;
ALTER TABLE lab.voting_sessions ADD COLUMN token_enc bytea;   -- session token encrypted with a key the DB never sees; cleared after the vote

CREATE FUNCTION admin.staff_by_username(p text) RETURNS TABLE(id uuid, org_id uuid, role text, password_hash text, totp_secret bytea) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$SELECT a.id, a.org_id, a.role, a.password_hash, a.totp_secret FROM admin.admins a WHERE a.username = p$$;
CREATE FUNCTION admin.staff_open_session(p_hash bytea, p_staff uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$INSERT INTO admin.staff_sessions VALUES (p_hash, p_staff, false, now() + interval '15 minutes')$$;
CREATE FUNCTION admin.staff_session(p_hash bytea) RETURNS TABLE(staff_id uuid, org_id uuid, role text, mfa_verified boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$SELECT a.id, a.org_id, a.role, s.mfa_verified FROM admin.staff_sessions s JOIN admin.admins a ON a.id = s.staff_id WHERE s.id_hash = p_hash AND s.expires_at > now()$$;
CREATE FUNCTION admin.staff_session_secret(p_hash bytea) RETURNS TABLE(totp_secret bytea, totp_last_step bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$SELECT a.totp_secret, a.totp_last_step FROM admin.staff_sessions s JOIN admin.admins a ON a.id = s.staff_id WHERE s.id_hash = p_hash AND s.expires_at > now()$$;
CREATE FUNCTION admin.staff_mfa_ok(p_hash bytea, p_step bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$   -- a code step can be used once
DECLARE n int;
BEGIN UPDATE admin.admins a SET totp_last_step = p_step FROM admin.staff_sessions s WHERE s.id_hash = p_hash AND s.staff_id = a.id AND s.expires_at > now() AND a.totp_last_step < p_step;
  GET DIAGNOSTICS n = ROW_COUNT; IF n = 0 THEN RETURN false; END IF; UPDATE admin.staff_sessions SET mfa_verified = true WHERE id_hash = p_hash; RETURN true; END$$;
CREATE FUNCTION admin.turnout(p_election uuid, p_staff uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$   -- aggregate only
BEGIN IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  RETURN jsonb_build_object('eligible', (SELECT count(*) FROM election.voters WHERE election_id = p_election),
    'online', (SELECT count(*) FROM participation.participation WHERE election_id = p_election AND channel = 'ONLINE'),
    'lab', (SELECT count(*) FROM participation.participation WHERE election_id = p_election AND channel = 'LAB')); END$$;

CREATE FUNCTION lab.attach_token(p_session uuid, p_enc bytea) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$UPDATE lab.voting_sessions SET token_enc = p_enc WHERE id = p_session AND status = 'ISSUED'$$;
CREATE FUNCTION lab.clear_token(p_session uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$UPDATE lab.voting_sessions SET token_enc = NULL WHERE id = p_session$$;
CREATE FUNCTION lab.pending_token(p_booth uuid) RETURNS bytea LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$SELECT token_enc FROM lab.voting_sessions WHERE booth_id = p_booth AND status = 'ISSUED' AND expires_at > now()$$;
CREATE FUNCTION lab.session_info(p_token_hash bytea, p_booth uuid) RETURNS TABLE(session_id uuid, voter_id uuid, election_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$SELECT id, voter_id, election_id FROM lab.voting_sessions WHERE token_hash = p_token_hash AND booth_id = p_booth AND status = 'STARTED' AND expires_at > now()$$;
CREATE FUNCTION lab.session_election(p_session uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$SELECT election_id FROM lab.voting_sessions WHERE id = p_session$$;
CREATE FUNCTION lab.board(p_election uuid, p_staff uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$   -- booth states and aggregate counts only
BEGIN IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  RETURN jsonb_build_object('booths', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label, 'assistive', b.assistive,
      'state', CASE WHEN NOT b.enabled THEN 'DISABLED' WHEN EXISTS (SELECT 1 FROM lab.voting_sessions s WHERE s.booth_id = b.id AND s.status IN ('ISSUED','STARTED')) THEN 'BUSY' ELSE 'IDLE' END) ORDER BY b.label) FROM lab.booths b), '[]'::jsonb),
    'voted', (SELECT count(*) FROM participation.participation WHERE election_id = p_election AND channel = 'LAB'),
    'eligible', (SELECT count(*) FROM election.voters WHERE election_id = p_election AND channel = 'LAB')); END$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA admin, lab FROM PUBLIC;
GRANT USAGE ON SCHEMA admin TO app_api;
GRANT EXECUTE ON FUNCTION admin.same_org, admin.request_action, admin.approve, admin.freeze, admin.ratify_freeze, admin.staff_by_username, admin.staff_open_session, admin.staff_session,
  admin.staff_session_secret, admin.staff_mfa_ok, admin.turnout, lab.attach_token, lab.clear_token, lab.pending_token, lab.session_info, lab.session_election, lab.board, lab.cancel_session TO app_api;
