-- Contests, candidates and server-side ballot scope. scope: {"all":true} or {"match":{"program":"BSIT"}} matched against voters.attrs.
ALTER TABLE election.voters ADD COLUMN attrs jsonb NOT NULL DEFAULT '{}';
CREATE TABLE election.positions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), election_id uuid NOT NULL REFERENCES election.elections,
  title text NOT NULL, seats int NOT NULL CHECK (seats > 0), min_sel int NOT NULL DEFAULT 0 CHECK (min_sel >= 0), allow_abstain boolean NOT NULL DEFAULT true,
  scope jsonb NOT NULL DEFAULT '{"all":true}', sort int NOT NULL DEFAULT 0, CHECK (min_sel <= seats));
CREATE TABLE election.candidates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), election_id uuid NOT NULL REFERENCES election.elections,
  position_id uuid NOT NULL REFERENCES election.positions, name text NOT NULL, platform text, withdrawn_at timestamptz);
CREATE FUNCTION election.voter_contests(p_election uuid, p_voter uuid) RETURNS SETOF election.positions
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.* FROM election.positions p JOIN election.voters v ON v.id = p_voter AND v.election_id = p_election
   WHERE p.election_id = p_election AND (COALESCE((p.scope->>'all')::boolean, false) OR (jsonb_exists(p.scope, 'match') AND v.attrs @> (p.scope->'match')))
   ORDER BY p.sort, p.title $$;
DO $$DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['positions','candidates'] LOOP
  EXECUTE format('ALTER TABLE election.%I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('REVOKE ALL ON election.%I FROM PUBLIC', t); END LOOP; END$$;
