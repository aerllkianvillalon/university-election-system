-- What the staff console needs: who am I, the approval queue, withdrawing a request, ending a session.
ALTER TABLE admin.approvals ADD COLUMN cancelled_by uuid REFERENCES admin.admins, ADD COLUMN cancelled_at timestamptz;

-- Approving a cancelled request is refused (everything else is exactly as in 0013).
CREATE OR REPLACE FUNCTION admin.approve(p_approval uuid, p_admin uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a admin.approvals%ROWTYPE; r text;
BEGIN
  SELECT * INTO a FROM admin.approvals WHERE id = p_approval AND executed_at IS NULL AND cancelled_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF a.initiator = p_admin THEN RAISE EXCEPTION 'SAME_ADMIN'; END IF;
  IF NOT admin.same_org(a.election_id, p_admin) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  r := admin.gate(a.election_id, a.action, a.params); IF r IS NOT NULL THEN RAISE EXCEPTION 'GATE:%', r; END IF;
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

-- Either admin of the organization can withdraw a pending request (the requester, to fix a mistake; the other admin, to refuse it).
CREATE FUNCTION admin.cancel_request(p_approval uuid, p_admin uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a admin.approvals%ROWTYPE;
BEGIN
  SELECT * INTO a FROM admin.approvals WHERE id = p_approval AND executed_at IS NULL AND cancelled_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF NOT admin.same_org(a.election_id, p_admin) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  UPDATE admin.approvals SET cancelled_by = p_admin, cancelled_at = now() WHERE id = p_approval;
  INSERT INTO ops.audit(staff_id, election_id, action, detail) VALUES (p_admin, a.election_id, 'REQUEST_CANCELLED', jsonb_build_object('action', a.action, 'initiator', a.initiator));
END$$;

CREATE FUNCTION admin.pending_approvals(p_election uuid, p_staff uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN IF NOT admin.same_org(p_election, p_staff) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  RETURN jsonb_build_object(
    'pending', coalesce((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'action', x.action, 'params', x.params, 'createdAt', x.created_at, 'initiator', i.name, 'mine', x.initiator = p_staff) ORDER BY x.created_at)
        FROM admin.approvals x JOIN admin.admins i ON i.id = x.initiator WHERE x.election_id = p_election AND x.executed_at IS NULL AND x.cancelled_at IS NULL), '[]'),
    'recent', coalesce((SELECT jsonb_agg(jsonb_build_object('action', t.action, 'params', t.params, 'initiator', t.initiator, 'approver', t.approver, 'at', t.at) ORDER BY t.at DESC)
        FROM (SELECT x.action, x.params, i.name AS initiator, ap.name AS approver, x.executed_at AS at FROM admin.approvals x JOIN admin.admins i ON i.id = x.initiator JOIN admin.admins ap ON ap.id = x.approver
               WHERE x.election_id = p_election AND x.executed_at IS NOT NULL ORDER BY x.executed_at DESC LIMIT 10) t), '[]')); END$$;

CREATE FUNCTION admin.staff_overview(p_staff uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('name', a.name, 'role', a.role, 'organization', o.name,
    'elections', coalesce((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'status', e.status, 'paused', e.paused, 'frozen', e.frozen, 'opensAt', e.opens_at, 'closesAt', e.closes_at, 'certifiedAt', e.certified_at,
      'freezeByMe', e.freeze_by IS NOT DISTINCT FROM p_staff AND e.frozen, 'freezeConfirmed', e.freeze_ratified_by IS NOT NULL) ORDER BY e.opens_at DESC NULLS LAST, e.id)
      FROM election.elections e WHERE e.org_id = a.org_id), '[]'))
  FROM admin.admins a JOIN org.organizations o ON o.id = a.org_id WHERE a.id = p_staff $$;

CREATE FUNCTION admin.staff_close_session(p_hash bytea) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$DELETE FROM admin.staff_sessions WHERE id_hash = p_hash$$;

REVOKE ALL ON FUNCTION admin.cancel_request, admin.pending_approvals, admin.staff_overview, admin.staff_close_session FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.cancel_request, admin.pending_approvals, admin.staff_overview, admin.staff_close_session TO app_api;
