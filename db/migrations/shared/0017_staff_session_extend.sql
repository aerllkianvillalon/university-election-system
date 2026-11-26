-- Staff can ask for more time before the 15-minute session ends. Each extension gives 15 more minutes, but a session never lives longer than 8 hours in total,
-- so "stay signed in" cannot turn into an open-ended login. Only a session that has passed the authenticator step can be extended.
ALTER TABLE admin.staff_sessions ADD COLUMN started_at timestamptz NOT NULL DEFAULT now();
CREATE FUNCTION admin.staff_session_expiry(p_hash bytea) RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$SELECT expires_at FROM admin.staff_sessions WHERE id_hash = p_hash AND mfa_verified AND expires_at > now()$$;
CREATE FUNCTION admin.staff_session_extend(p_hash bytea) RETURNS timestamptz LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$UPDATE admin.staff_sessions SET expires_at = least(now() + interval '15 minutes', started_at + interval '8 hours')
   WHERE id_hash = p_hash AND mfa_verified AND expires_at > now() RETURNING expires_at$$;
REVOKE ALL ON FUNCTION admin.staff_session_expiry, admin.staff_session_extend FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.staff_session_expiry, admin.staff_session_extend TO app_api;
