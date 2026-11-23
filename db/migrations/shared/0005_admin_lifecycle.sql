-- Election lifecycle gates, dual approval (two distinct admins of the same organization), and freeze that lifts itself unless ratified in 15 min.
CREATE SCHEMA admin;
ALTER TABLE election.elections ADD COLUMN public_key bytea, ADD COLUMN freeze_started_at timestamptz, ADD COLUMN freeze_by uuid, ADD COLUMN freeze_ratified_by uuid;
CREATE TABLE admin.admins(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES org.organizations, name text NOT NULL);
CREATE TABLE admin.approvals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), election_id uuid NOT NULL REFERENCES election.elections,
  action text NOT NULL CHECK (action IN ('lock','open','pause','resume','extend','close','unfreeze')), params jsonb NOT NULL DEFAULT '{}',
  initiator uuid NOT NULL REFERENCES admin.admins, approver uuid REFERENCES admin.admins, created_at timestamptz NOT NULL DEFAULT now(), executed_at timestamptz,
  CHECK (approver IS NULL OR approver <> initiator));

CREATE FUNCTION admin.same_org(p_election uuid, p_admin uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$SELECT EXISTS (SELECT 1 FROM election.elections e JOIN admin.admins a ON a.org_id = e.org_id WHERE e.id = p_election AND a.id = p_admin)$$;

-- Returns NULL when the action is allowed, else the blocking reason.
CREATE FUNCTION admin.gate(p_election uuid, p_action text, p_params jsonb) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e election.elections%ROWTYPE;
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
    IF e.opens_at IS NULL OR e.closes_at IS NULL OR e.closes_at <= e.opens_at THEN RETURN 'NO_WINDOW'; END IF;
  ELSIF p_action = 'pause' THEN IF e.status <> 'OPEN' OR e.paused THEN RETURN 'BAD_STATE'; END IF;
  ELSIF p_action = 'resume' THEN IF NOT e.paused THEN RETURN 'BAD_STATE'; END IF; IF e.frozen THEN RETURN 'FROZEN'; END IF;
  ELSIF p_action = 'extend' THEN IF e.status <> 'OPEN' THEN RETURN 'BAD_STATE'; END IF;
    IF COALESCE((p_params->>'minutes')::int, 0) NOT BETWEEN 1 AND 1440 THEN RETURN 'EXTENSION_CAP'; END IF;
  ELSIF p_action = 'close' THEN IF e.status <> 'OPEN' THEN RETURN 'BAD_STATE'; END IF;
  ELSIF p_action = 'unfreeze' THEN IF NOT e.frozen THEN RETURN 'BAD_STATE'; END IF;
  END IF;
  RETURN NULL;
END$$;

CREATE FUNCTION admin.request_action(p_election uuid, p_action text, p_params jsonb, p_admin uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r text; id uuid;
BEGIN
  IF NOT admin.same_org(p_election, p_admin) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  r := admin.gate(p_election, p_action, p_params); IF r IS NOT NULL THEN RAISE EXCEPTION 'GATE:%', r; END IF;
  INSERT INTO admin.approvals(election_id, action, params, initiator) VALUES (p_election, p_action, p_params, p_admin) RETURNING admin.approvals.id INTO id; RETURN id;
END$$;

CREATE FUNCTION admin.approve(p_approval uuid, p_admin uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a admin.approvals%ROWTYPE; r text;
BEGIN
  SELECT * INTO a FROM admin.approvals WHERE id = p_approval AND executed_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF a.initiator = p_admin THEN RAISE EXCEPTION 'SAME_ADMIN'; END IF;
  IF NOT admin.same_org(a.election_id, p_admin) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  r := admin.gate(a.election_id, a.action, a.params); IF r IS NOT NULL THEN RAISE EXCEPTION 'GATE:%', r; END IF;
  UPDATE election.elections SET
    status = CASE a.action WHEN 'lock' THEN 'LOCKED' WHEN 'open' THEN 'OPEN' WHEN 'close' THEN 'CLOSED' ELSE status END,
    paused = CASE a.action WHEN 'pause' THEN true WHEN 'resume' THEN false ELSE paused END,
    closes_at = CASE a.action WHEN 'extend' THEN closes_at + make_interval(mins => (a.params->>'minutes')::int) ELSE closes_at END,
    frozen = CASE a.action WHEN 'unfreeze' THEN false ELSE frozen END,
    freeze_started_at = CASE a.action WHEN 'unfreeze' THEN NULL ELSE freeze_started_at END,
    freeze_by = CASE a.action WHEN 'unfreeze' THEN NULL ELSE freeze_by END, freeze_ratified_by = CASE a.action WHEN 'unfreeze' THEN NULL ELSE freeze_ratified_by END
   WHERE id = a.election_id;
  UPDATE admin.approvals SET approver = p_admin, executed_at = now() WHERE id = p_approval;
END$$;

-- One admin may freeze immediately; it lifts itself after 15 minutes unless a DIFFERENT admin ratifies it.
CREATE FUNCTION admin.freeze(p_election uuid, p_admin uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN IF NOT admin.same_org(p_election, p_admin) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  UPDATE election.elections SET frozen = true, freeze_started_at = now(), freeze_by = p_admin, freeze_ratified_by = NULL WHERE id = p_election AND status = 'OPEN' AND NOT frozen;
  IF NOT FOUND THEN RAISE EXCEPTION 'GATE:BAD_STATE'; END IF; END$$;
CREATE FUNCTION admin.ratify_freeze(p_election uuid, p_admin uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN IF NOT admin.same_org(p_election, p_admin) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  UPDATE election.elections SET freeze_ratified_by = p_admin WHERE id = p_election AND frozen AND freeze_ratified_by IS NULL AND freeze_by <> p_admin;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAME_ADMIN_OR_BAD_STATE'; END IF; END$$;
CREATE FUNCTION admin.lift_expired_freezes() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH u AS (UPDATE election.elections SET frozen = false, freeze_started_at = NULL, freeze_by = NULL
     WHERE frozen AND freeze_ratified_by IS NULL AND freeze_started_at < now() - interval '15 minutes' RETURNING 1) SELECT count(*)::int FROM u $$;
DO $$DECLARE t record; BEGIN FOR t IN SELECT tablename n FROM pg_tables WHERE schemaname='admin' LOOP
  EXECUTE format('ALTER TABLE admin.%I ENABLE ROW LEVEL SECURITY', t.n); EXECUTE format('REVOKE ALL ON admin.%I FROM PUBLIC', t.n); END LOOP; END$$;
