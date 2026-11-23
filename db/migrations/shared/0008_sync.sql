-- Package import bookkeeping (central) and incident log (central and lab).
CREATE SCHEMA sync;
CREATE TABLE sync.labs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), election_id uuid NOT NULL REFERENCES election.elections, name text NOT NULL, chain_id text NOT NULL UNIQUE, public_key bytea NOT NULL);
CREATE TABLE sync.imports(package_id bytea PRIMARY KEY, election_id uuid NOT NULL, lab_id uuid NOT NULL REFERENCES sync.labs, pkg_type text NOT NULL, ballot_count int NOT NULL, chain_tip bytea, imported_at timestamptz NOT NULL DEFAULT now(), report jsonb NOT NULL);
CREATE TABLE sync.quarantine(id bigserial PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now(), reason text NOT NULL, manifest jsonb);
CREATE TABLE ops.incidents(id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), election_id uuid, kind text NOT NULL, detail text);
CREATE FUNCTION ops.freeze_for_incident(p_election uuid, p_kind text, p_detail text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN UPDATE election.elections SET frozen = true, freeze_started_at = now(), freeze_by = NULL, freeze_ratified_by = NULL WHERE id = p_election;
  INSERT INTO ops.incidents(election_id, kind, detail) VALUES (p_election, p_kind, p_detail); END$$;
DO $$DECLARE t record; BEGIN FOR t IN SELECT schemaname s, tablename n FROM pg_tables WHERE schemaname = 'sync' OR (schemaname='ops' AND tablename='incidents') LOOP
  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.s, t.n); EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC', t.s, t.n); END LOOP; END$$;
REVOKE ALL ON FUNCTION ops.freeze_for_incident FROM PUBLIC;
