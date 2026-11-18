-- Audit log: hash-chained, insert-only, readable by administrators of the same organization.
-- Every row commits to the one before it (commit order, via ops.audit_head), so a deleted or edited row breaks the chain from that point on.
ALTER TABLE ops.audit ADD COLUMN seq bigint UNIQUE, ADD COLUMN prev_hash bytea, ADD COLUMN entry_hash bytea;
CREATE TABLE ops.audit_head(only_row boolean PRIMARY KEY DEFAULT true CHECK (only_row), seq bigint NOT NULL, hash bytea NOT NULL);
ALTER TABLE ops.audit_head ENABLE ROW LEVEL SECURITY; REVOKE ALL ON ops.audit_head FROM PUBLIC;

-- What an entry commits to. Time is rendered in UTC with microseconds so the text never depends on a session's TimeZone; jsonb text is already canonical.
CREATE FUNCTION ops.audit_hash(p_prev bytea, p_seq bigint, p_at timestamptz, p_staff uuid, p_election uuid, p_action text, p_detail jsonb) RETURNS bytea
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS
$$SELECT sha256(convert_to(encode(p_prev,'hex') || '|' || p_seq || '|' || to_char(p_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '|' || coalesce(p_staff::text,'') || '|' || coalesce(p_election::text,'') || '|' || p_action || '|' || p_detail::text, 'UTF8'))$$;

-- Existing rows are chained in id order, once.
DO $$ DECLARE r record; prev bytea := '\x00'::bytea; s bigint := 0; h bytea;
BEGIN
  FOR r IN SELECT * FROM ops.audit ORDER BY id LOOP
    s := s + 1; h := ops.audit_hash(prev, s, r.at, r.staff_id, r.election_id, r.action, r.detail);
    UPDATE ops.audit SET seq = s, prev_hash = prev, entry_hash = h WHERE id = r.id; prev := h;
  END LOOP;
  INSERT INTO ops.audit_head(seq, hash) VALUES (s, prev);
END $$;
ALTER TABLE ops.audit ALTER COLUMN seq SET NOT NULL, ALTER COLUMN prev_hash SET NOT NULL, ALTER COLUMN entry_hash SET NOT NULL;

-- The head row is locked for the rest of the writing transaction, so two writers can never extend the same predecessor.
CREATE FUNCTION ops.audit_link() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE h ops.audit_head;
BEGIN
  SELECT * INTO h FROM ops.audit_head WHERE only_row FOR UPDATE;
  NEW.seq := h.seq + 1; NEW.prev_hash := h.hash;
  NEW.entry_hash := ops.audit_hash(h.hash, NEW.seq, NEW.at, NEW.staff_id, NEW.election_id, NEW.action, NEW.detail);
  UPDATE ops.audit_head SET seq = NEW.seq, hash = NEW.entry_hash WHERE only_row;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_link BEFORE INSERT ON ops.audit FOR EACH ROW EXECUTE FUNCTION ops.audit_link();

CREATE FUNCTION ops.audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'AUDIT_IMMUTABLE'; END $$;
CREATE TRIGGER audit_no_change BEFORE UPDATE OR DELETE ON ops.audit FOR EACH ROW EXECUTE FUNCTION ops.audit_immutable();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON ops.audit FOR EACH STATEMENT EXECUTE FUNCTION ops.audit_immutable();

-- Walks the whole chain. ok = every link recomputes and the last one equals the head; first_bad is the first sequence number that does not.
CREATE FUNCTION ops.audit_verify(OUT ok boolean, OUT checked bigint, OUT first_bad bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record; prev bytea := '\x00'::bytea; n bigint := 0; hd ops.audit_head;
BEGIN
  ok := true; checked := 0; first_bad := NULL;
  FOR r IN SELECT * FROM ops.audit ORDER BY seq LOOP
    n := n + 1;
    IF r.seq <> n OR r.prev_hash <> prev OR r.entry_hash <> ops.audit_hash(prev, r.seq, r.at, r.staff_id, r.election_id, r.action, r.detail) THEN ok := false; first_bad := n; checked := n - 1; RETURN; END IF;
    prev := r.entry_hash;
  END LOOP;
  SELECT * INTO hd FROM ops.audit_head WHERE only_row;
  checked := n;
  IF hd.seq <> n OR hd.hash <> prev THEN ok := false; first_bad := n + 1; END IF;   -- rows removed from the end
END $$;

-- Administrators read their own organization's trail: entries about its elections, and entries made by its own staff outside any election.
CREATE FUNCTION admin.audit_list(p_staff uuid, p_limit int, p_before bigint, p_action text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a admin.admins; res jsonb;
BEGIN
  SELECT * INTO a FROM admin.admins WHERE id = p_staff AND status = 'ACTIVE';
  IF NOT FOUND OR a.role <> 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT coalesce(jsonb_agg(x ORDER BY (x->>'seq')::bigint DESC), '[]'::jsonb) INTO res FROM (
    SELECT jsonb_build_object('seq', l.seq, 'at', l.at, 'action', l.action, 'by', s.username, 'detail', l.detail, 'hash', left(encode(l.entry_hash,'hex'), 16)) AS x
    FROM ops.audit l LEFT JOIN admin.admins s ON s.id = l.staff_id
    WHERE (l.election_id IN (SELECT id FROM election.elections WHERE org_id = a.org_id) OR (l.election_id IS NULL AND s.org_id = a.org_id))
      AND (p_before IS NULL OR l.seq < p_before) AND (p_action IS NULL OR l.action = p_action)
    ORDER BY l.seq DESC LIMIT greatest(1, least(coalesce(p_limit, 50), 200))) q;
  RETURN res;
END $$;
CREATE FUNCTION admin.audit_check(p_staff uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v record; hd ops.audit_head;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin.admins WHERE id = p_staff AND status = 'ACTIVE' AND role = 'ADMIN') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT * INTO v FROM ops.audit_verify(); SELECT * INTO hd FROM ops.audit_head WHERE only_row;
  RETURN jsonb_build_object('ok', v.ok, 'checked', v.checked, 'head', left(encode(hd.hash,'hex'), 16));
END $$;
REVOKE ALL ON FUNCTION ops.audit_verify, admin.audit_list, admin.audit_check FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.audit_list, admin.audit_check TO app_api;
