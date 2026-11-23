-- The API connects as app_api: no table owner rights, no access to ballots or participation, execute only on named functions.
DO $$BEGIN CREATE ROLE app_api LOGIN PASSWORD 'devpass'; EXCEPTION WHEN duplicate_object THEN NULL; END$$;
ALTER FUNCTION security.hit(text,int,int) SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA org, election, participation, ballots, identity, security, ops, admin FROM PUBLIC;
GRANT USAGE ON SCHEMA election, identity, security, ballots TO app_api;
GRANT SELECT ON election.voters, election.candidates, identity.accounts, identity.reset_tokens TO app_api;
GRANT SELECT, INSERT, DELETE ON identity.sessions TO app_api;
CREATE POLICY api_voters ON election.voters FOR SELECT TO app_api USING (true);
CREATE POLICY api_candidates ON election.candidates FOR SELECT TO app_api USING (true);
CREATE POLICY api_accounts ON identity.accounts FOR SELECT TO app_api USING (true);
CREATE POLICY api_reset ON identity.reset_tokens FOR SELECT TO app_api USING (true);
CREATE POLICY api_sessions ON identity.sessions FOR ALL TO app_api USING (true) WITH CHECK (true);
GRANT EXECUTE ON FUNCTION identity.register, identity.start_reset, identity.redeem_reset, election.voter_contests, ballots.cast_ballot, security.hit TO app_api;
