-- Staff account lifecycle: first administrators appointed with a one-time setup code, self-service password and authenticator changes,
-- recovery codes, and inviting / disabling / re-inviting colleagues. Adding or removing an ADMIN needs a different administrator to approve;
-- the same rule that protects the election protects who may run it.
ALTER TABLE admin.admins ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('INVITED','ACTIVE','DISABLED')),
  ADD COLUMN invited_by uuid REFERENCES admin.admins, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN pending_totp bytea;                      -- a new authenticator secret (sealed) that has not yet proved itself with a code
ALTER TABLE admin.staff_sessions ADD COLUMN recovered boolean NOT NULL DEFAULT false;   -- this session was opened with a recovery code
CREATE TABLE admin.setup_codes(admin_id uuid PRIMARY KEY REFERENCES admin.admins ON DELETE CASCADE, code_hash bytea NOT NULL UNIQUE, expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE TABLE admin.recovery_codes(admin_id uuid NOT NULL REFERENCES admin.admins ON DELETE CASCADE, code_hash bytea NOT NULL, used_at timestamptz, PRIMARY KEY (admin_id, code_hash));
CREATE TABLE admin.staff_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES org.organizations,
  action text NOT NULL CHECK (action IN ('invite','disable','reinvite')), params jsonb NOT NULL,
  initiator uuid NOT NULL REFERENCES admin.admins, approver uuid REFERENCES admin.admins, executed_at timestamptz,
  cancelled_by uuid REFERENCES admin.admins, cancelled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE admin.setup_codes ENABLE ROW LEVEL SECURITY; ALTER TABLE admin.recovery_codes ENABLE ROW LEVEL SECURITY; ALTER TABLE admin.staff_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON admin.setup_codes, admin.recovery_codes, admin.staff_requests FROM PUBLIC;

-- Only ACTIVE accounts can sign in, and a disabled account's existing sessions stop working at once.
CREATE OR REPLACE FUNCTION admin.staff_by_username(p text) RETURNS TABLE(id uuid, org_id uuid, role text, password_hash text, totp_secret bytea) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$SELECT a.id, a.org_id, a.role, a.password_hash, a.totp_secret FROM admin.admins a WHERE a.username = p AND a.status = 'ACTIVE'$$;
CREATE OR REPLACE FUNCTION admin.staff_session(p_hash bytea) RETURNS TABLE(staff_id uuid, org_id uuid, role text, mfa_verified boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$SELECT a.id, a.org_id, a.role, s.mfa_verified FROM admin.staff_sessions s JOIN admin.admins a ON a.id = s.staff_id WHERE s.id_hash = p_hash AND s.expires_at > now() AND a.status = 'ACTIVE'$$;
CREATE OR REPLACE FUNCTION admin.staff_session_secret(p_hash bytea) RETURNS TABLE(totp_secret bytea, totp_last_step bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$SELECT a.totp_secret, a.totp_last_step FROM admin.staff_sessions s JOIN admin.admins a ON a.id = s.staff_id WHERE s.id_hash = p_hash AND s.expires_at > now() AND a.status = 'ACTIVE'$$;

-- ---- internal building blocks (not granted to app_api; called by the functions below and by the setup tool) ----
CREATE FUNCTION admin.invite_staff(p_org uuid, p_by uuid, p_name text, p_username text, p_role text, p_hash bytea, p_days int) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE id uuid;
BEGIN
  IF p_username !~ '^[a-z0-9][a-z0-9._-]{2,31}$' OR length(coalesce(p_name, '')) NOT BETWEEN 1 AND 80 OR p_role NOT IN ('ADMIN','PROCTOR','OBSERVER') THEN RAISE EXCEPTION 'GATE:BAD_DETAILS'; END IF;
  BEGIN INSERT INTO admin.admins(org_id, name, username, role, status, invited_by) VALUES (p_org, p_name, p_username, p_role, 'INVITED', p_by) RETURNING admin.admins.id INTO id;
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'GATE:USERNAME_TAKEN'; END;
  INSERT INTO admin.setup_codes(admin_id, code_hash, expires_at) VALUES (id, p_hash, now() + make_interval(days => p_days));
  INSERT INTO ops.audit(staff_id, action, detail) VALUES (p_by, 'STAFF_INVITED', jsonb_build_object('staff_id', id, 'role', p_role));
  RETURN id; END$$;

CREATE FUNCTION admin.staff_action(p_actor uuid, p_org uuid, p_action text, p_params jsonb, p_hash bytea, p_days int) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t admin.admins%ROWTYPE; n int;
BEGIN
  IF p_action = 'invite' THEN
    PERFORM admin.invite_staff(p_org, p_actor, p_params->>'name', p_params->>'username', p_params->>'role', p_hash, p_days);
    RETURN jsonb_build_object('action', 'invite', 'username', p_params->>'username', 'role', p_params->>'role');
  END IF;
  SELECT * INTO t FROM admin.admins WHERE id = (p_params->>'staffId')::uuid AND org_id = p_org; IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF t.id = p_actor THEN RAISE EXCEPTION 'GATE:SELF'; END IF;
  SELECT count(*) INTO n FROM admin.admins WHERE org_id = p_org AND role = 'ADMIN' AND status = 'ACTIVE';
  IF t.role = 'ADMIN' AND t.status = 'ACTIVE' AND n - 1 < 2 THEN RAISE EXCEPTION 'GATE:TOO_FEW_ADMINS'; END IF;   -- two-person rules need two people
  DELETE FROM admin.staff_sessions WHERE staff_id = t.id;
  IF p_action = 'disable' THEN
    UPDATE admin.admins SET status = 'DISABLED' WHERE id = t.id; DELETE FROM admin.setup_codes WHERE admin_id = t.id;
  ELSIF p_action = 'reinvite' THEN       -- lost phone AND lost recovery codes: back to the setup flow with a fresh one-time code
    UPDATE admin.admins SET status = 'INVITED', password_hash = NULL, totp_secret = NULL, pending_totp = NULL, totp_last_step = 0 WHERE id = t.id;
    DELETE FROM admin.recovery_codes WHERE admin_id = t.id; DELETE FROM admin.setup_codes WHERE admin_id = t.id;
    INSERT INTO admin.setup_codes(admin_id, code_hash, expires_at) VALUES (t.id, p_hash, now() + make_interval(days => p_days));
  ELSE RAISE EXCEPTION 'NOT_FOUND'; END IF;
  INSERT INTO ops.audit(staff_id, action, detail) VALUES (p_actor, 'STAFF_' || upper(p_action), jsonb_build_object('staff_id', t.id));
  RETURN jsonb_build_object('action', p_action, 'username', t.username, 'name', t.name);
END$$;

-- ---- console: the directory and the two-person queue ----
CREATE FUNCTION admin.staff_directory(p_staff uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid;
BEGIN SELECT org_id INTO org FROM admin.admins WHERE id = p_staff AND status = 'ACTIVE' AND role = 'ADMIN'; IF org IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  RETURN jsonb_build_object(
    'staff', coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'username', a.username, 'role', a.role, 'status', a.status, 'createdAt', a.created_at, 'me', a.id = p_staff) ORDER BY a.created_at, a.username) FROM admin.admins a WHERE a.org_id = org), '[]'),
    'pending', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'action', r.action, 'params', r.params, 'target', coalesce(t.name, r.params->>'name'), 'initiator', i.name, 'mine', r.initiator = p_staff, 'createdAt', r.created_at) ORDER BY r.created_at)
        FROM admin.staff_requests r JOIN admin.admins i ON i.id = r.initiator LEFT JOIN admin.admins t ON t.id = NULLIF(r.params->>'staffId', '')::uuid
       WHERE r.org_id = org AND r.executed_at IS NULL AND r.cancelled_at IS NULL), '[]'));
END$$;

-- Ask to invite / disable / re-invite. ADMIN targets (and ADMIN invitations) wait for a different administrator; others happen at once.
-- p_hash is a fresh setup code's hash: used only if the action happens now.
CREATE FUNCTION admin.staff_request(p_actor uuid, p_action text, p_params jsonb, p_hash bytea, p_days int) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a admin.admins%ROWTYPE; t admin.admins%ROWTYPE; two boolean; rid uuid;
BEGIN
  SELECT * INTO a FROM admin.admins WHERE id = p_actor AND status = 'ACTIVE' AND role = 'ADMIN'; IF NOT FOUND THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p_action NOT IN ('invite','disable','reinvite') THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF p_action = 'invite' THEN
    IF coalesce(p_params->>'username', '') !~ '^[a-z0-9][a-z0-9._-]{2,31}$' OR length(coalesce(p_params->>'name', '')) NOT BETWEEN 1 AND 80 OR coalesce(p_params->>'role', '') NOT IN ('ADMIN','PROCTOR','OBSERVER') THEN RAISE EXCEPTION 'GATE:BAD_DETAILS'; END IF;
    IF EXISTS (SELECT 1 FROM admin.admins WHERE username = p_params->>'username') THEN RAISE EXCEPTION 'GATE:USERNAME_TAKEN'; END IF;
    two := p_params->>'role' = 'ADMIN';
    p_params := jsonb_build_object('name', p_params->>'name', 'username', p_params->>'username', 'role', p_params->>'role');
  ELSE
    SELECT * INTO t FROM admin.admins WHERE id = (p_params->>'staffId')::uuid AND org_id = a.org_id; IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
    IF t.id = p_actor THEN RAISE EXCEPTION 'GATE:SELF'; END IF;
    two := t.role = 'ADMIN'; p_params := jsonb_build_object('staffId', t.id);
  END IF;
  IF two THEN
    INSERT INTO admin.staff_requests(org_id, action, params, initiator) VALUES (a.org_id, p_action, p_params, p_actor) RETURNING id INTO rid;
    INSERT INTO ops.audit(staff_id, action, detail) VALUES (p_actor, 'STAFF_REQUEST', jsonb_build_object('request', rid, 'action', p_action));
    RETURN jsonb_build_object('pending', true, 'id', rid);
  END IF;
  RETURN jsonb_build_object('pending', false) || admin.staff_action(p_actor, a.org_id, p_action, p_params, p_hash, p_days);
END$$;

CREATE FUNCTION admin.staff_request_approve(p_request uuid, p_approver uuid, p_hash bytea, p_days int) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r admin.staff_requests%ROWTYPE; res jsonb;
BEGIN
  SELECT * INTO r FROM admin.staff_requests WHERE id = p_request AND executed_at IS NULL AND cancelled_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF NOT EXISTS (SELECT 1 FROM admin.admins WHERE id = p_approver AND org_id = r.org_id AND role = 'ADMIN' AND status = 'ACTIVE') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF r.initiator = p_approver THEN RAISE EXCEPTION 'SAME_ADMIN'; END IF;
  res := admin.staff_action(p_approver, r.org_id, r.action, r.params, p_hash, p_days);   -- re-checked now: the rules may have changed since the request
  UPDATE admin.staff_requests SET approver = p_approver, executed_at = now() WHERE id = p_request;
  RETURN res; END$$;
CREATE FUNCTION admin.staff_request_cancel(p_request uuid, p_staff uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r admin.staff_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM admin.staff_requests WHERE id = p_request AND executed_at IS NULL AND cancelled_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF NOT EXISTS (SELECT 1 FROM admin.admins WHERE id = p_staff AND org_id = r.org_id AND role = 'ADMIN' AND status = 'ACTIVE') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  UPDATE admin.staff_requests SET cancelled_by = p_staff, cancelled_at = now() WHERE id = p_request;
  INSERT INTO ops.audit(staff_id, action, detail) VALUES (p_staff, 'STAFF_REQUEST_CANCELLED', jsonb_build_object('request', p_request, 'action', r.action)); END$$;

-- ---- setup: someone with a setup code becomes an active account (public, rate limited by the API) ----
CREATE FUNCTION admin.setup_peek(p_username text, p_hash bytea) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('name', a.name, 'role', a.role) FROM admin.admins a JOIN admin.setup_codes c ON c.admin_id = a.id
   WHERE a.username = p_username AND a.status = 'INVITED' AND c.code_hash = p_hash AND c.used_at IS NULL AND c.expires_at > now() $$;
CREATE FUNCTION admin.setup_stage(p_username text, p_hash bytea, p_sealed bytea) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN IF admin.setup_peek(p_username, p_hash) IS NULL THEN RETURN false; END IF; UPDATE admin.admins SET pending_totp = p_sealed WHERE username = p_username; RETURN true; END$$;
CREATE FUNCTION admin.setup_pending(p_username text, p_hash bytea) RETURNS bytea LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.pending_totp FROM admin.admins a WHERE a.username = p_username AND admin.setup_peek(p_username, p_hash) IS NOT NULL $$;
CREATE FUNCTION admin.setup_complete(p_username text, p_hash bytea, p_password_hash text, p_step bigint, p_recovery bytea[]) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a admin.admins%ROWTYPE; h bytea;
BEGIN
  IF admin.setup_peek(p_username, p_hash) IS NULL THEN RETURN false; END IF;
  SELECT * INTO a FROM admin.admins WHERE username = p_username FOR UPDATE; IF a.pending_totp IS NULL THEN RETURN false; END IF;
  UPDATE admin.admins SET password_hash = p_password_hash, totp_secret = pending_totp, pending_totp = NULL, totp_last_step = p_step, status = 'ACTIVE' WHERE id = a.id;
  UPDATE admin.setup_codes SET used_at = now() WHERE admin_id = a.id;
  DELETE FROM admin.recovery_codes WHERE admin_id = a.id; FOREACH h IN ARRAY p_recovery LOOP INSERT INTO admin.recovery_codes(admin_id, code_hash) VALUES (a.id, h); END LOOP;
  INSERT INTO ops.audit(staff_id, action, detail) VALUES (a.id, 'STAFF_SETUP_COMPLETE', jsonb_build_object('role', a.role));
  RETURN true; END$$;

CREATE OR REPLACE FUNCTION admin.staff_overview(p_staff uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('name', a.name, 'username', a.username, 'role', a.role, 'organization', o.name,
    'elections', coalesce((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'status', e.status, 'paused', e.paused, 'frozen', e.frozen, 'opensAt', e.opens_at, 'closesAt', e.closes_at, 'certifiedAt', e.certified_at,
        'freezeByMe', e.freeze_by IS NOT DISTINCT FROM p_staff AND e.frozen, 'freezeConfirmed', e.freeze_ratified_by IS NOT NULL) ORDER BY e.opens_at DESC NULLS LAST, e.id)
      FROM election.elections e WHERE e.org_id = a.org_id), '[]'))
  FROM admin.admins a JOIN org.organizations o ON o.id = a.org_id WHERE a.id = p_staff $$;

-- ---- account security, for a signed-in person about themselves ----
CREATE FUNCTION admin.staff_credentials(p_staff uuid) RETURNS TABLE(username text, password_hash text, totp_secret bytea, pending_totp bytea, totp_last_step bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$SELECT a.username, a.password_hash, a.totp_secret, a.pending_totp, a.totp_last_step FROM admin.admins a WHERE a.id = p_staff AND a.status = 'ACTIVE'$$;
CREATE FUNCTION admin.change_password(p_staff uuid, p_new text, p_keep bytea) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN UPDATE admin.admins SET password_hash = p_new WHERE id = p_staff AND status = 'ACTIVE'; IF NOT FOUND THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  DELETE FROM admin.staff_sessions WHERE staff_id = p_staff AND id_hash <> p_keep;   -- anyone else signed in as you is signed out
  INSERT INTO ops.audit(staff_id, action) VALUES (p_staff, 'STAFF_PASSWORD_CHANGED'); END$$;
CREATE FUNCTION admin.stage_authenticator(p_staff uuid, p_sealed bytea) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$UPDATE admin.admins SET pending_totp = p_sealed WHERE id = p_staff AND status = 'ACTIVE'$$;
CREATE FUNCTION admin.confirm_authenticator(p_staff uuid, p_step bigint, p_keep bytea) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN UPDATE admin.admins SET totp_secret = pending_totp, pending_totp = NULL, totp_last_step = p_step WHERE id = p_staff AND status = 'ACTIVE' AND pending_totp IS NOT NULL; IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM admin.staff_sessions WHERE staff_id = p_staff AND id_hash <> p_keep;
  UPDATE admin.staff_sessions SET recovered = false WHERE id_hash = p_keep;          -- a new authenticator ends the "signed in with a recovery code" warning
  INSERT INTO ops.audit(staff_id, action) VALUES (p_staff, 'STAFF_AUTHENTICATOR_REPLACED'); RETURN true; END$$;
CREATE FUNCTION admin.replace_recovery_codes(p_staff uuid, p_hashes bytea[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE h bytea;
BEGIN DELETE FROM admin.recovery_codes WHERE admin_id = p_staff; FOREACH h IN ARRAY p_hashes LOOP INSERT INTO admin.recovery_codes(admin_id, code_hash) VALUES (p_staff, h); END LOOP;
  INSERT INTO ops.audit(staff_id, action) VALUES (p_staff, 'STAFF_RECOVERY_CODES_REPLACED'); END$$;
-- Sign in with a recovery code instead of an authenticator code: each works once, and the session is marked so the console insists on a new authenticator.
CREATE FUNCTION admin.use_recovery_code(p_session bytea, p_code bytea) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sid uuid;
BEGIN SELECT staff_id INTO sid FROM admin.staff_sessions WHERE id_hash = p_session AND expires_at > now(); IF sid IS NULL THEN RETURN false; END IF;
  UPDATE admin.recovery_codes SET used_at = now() WHERE admin_id = sid AND code_hash = p_code AND used_at IS NULL; IF NOT FOUND THEN RETURN false; END IF;
  UPDATE admin.staff_sessions SET mfa_verified = true, recovered = true WHERE id_hash = p_session;
  INSERT INTO ops.audit(staff_id, action) VALUES (sid, 'STAFF_RECOVERY_CODE_USED'); RETURN true; END$$;
CREATE FUNCTION admin.session_recovered(p_session bytea) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$SELECT coalesce((SELECT recovered FROM admin.staff_sessions WHERE id_hash = p_session AND expires_at > now()), false)$$;
CREATE FUNCTION admin.recovery_codes_left(p_staff uuid) RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$SELECT count(*)::int FROM admin.recovery_codes WHERE admin_id = p_staff AND used_at IS NULL$$;

REVOKE ALL ON FUNCTION admin.invite_staff, admin.staff_action, admin.staff_directory, admin.staff_request, admin.staff_request_approve, admin.staff_request_cancel, admin.setup_peek, admin.setup_stage, admin.setup_pending, admin.setup_complete,
  admin.staff_credentials, admin.change_password, admin.stage_authenticator, admin.confirm_authenticator, admin.replace_recovery_codes, admin.use_recovery_code, admin.session_recovered, admin.recovery_codes_left FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.staff_directory, admin.staff_request, admin.staff_request_approve, admin.staff_request_cancel, admin.setup_peek, admin.setup_stage, admin.setup_pending, admin.setup_complete,
  admin.staff_credentials, admin.change_password, admin.stage_authenticator, admin.confirm_authenticator, admin.replace_recovery_codes, admin.use_recovery_code, admin.session_recovered, admin.recovery_codes_left TO app_api;
-- invite_staff and staff_action are deliberately NOT granted: the API reaches them only through staff_request / staff_request_approve, which enforce who may do what.
