-- psql -v ON_ERROR_STOP=1 -f db/tests/setup_screens.sql   (after all migrations; rolls back, leaves nothing behind)
BEGIN;
INSERT INTO org.organizations(slug,name) VALUES('ss-a','A'),('ss-b','B');
INSERT INTO admin.admins(org_id,name,username,role,password_hash,totp_secret) SELECT id,'A','ss-admin-a','ADMIN','x','\x00' FROM org.organizations WHERE slug='ss-a';
INSERT INTO admin.admins(org_id,name,username,role,password_hash,totp_secret) SELECT id,'B','ss-admin-b','ADMIN','x','\x00' FROM org.organizations WHERE slug='ss-b';
INSERT INTO election.elections(org_id) SELECT id FROM org.organizations WHERE slug='ss-a';
CREATE TEMP TABLE ctx AS SELECT (SELECT e.id FROM election.elections e JOIN org.organizations o ON o.id=e.org_id WHERE o.slug='ss-a') AS e,
  (SELECT id FROM admin.admins WHERE username='ss-admin-a') AS a, (SELECT id FROM admin.admins WHERE username='ss-admin-b') AS b;
GRANT ALL ON ctx TO PUBLIC;
DO $$ DECLARE c ctx%ROWTYPE; p1 uuid; p2 uuid; c1 uuid; o jsonb; BEGIN SELECT * INTO c FROM ctx;
  p1 := admin.add_position(c.e,c.a,'President',1,0,true,'{"all":true}'); p2 := admin.add_position(c.e,c.a,'Treasurer',1,0,true,'{"all":true}');
  c1 := admin.add_candidate(c.e,c.a,p1,'Ana',NULL); PERFORM admin.add_candidate(c.e,c.a,p1,'Ben','Plan');
  PERFORM admin.import_roll(c.e,c.a,'[{"studentId":"1","channel":"ONLINE"},{"studentId":"2","channel":"ONLINE"}]');
  o := admin.setup_overview(c.e,c.a);
  ASSERT jsonb_array_length(o->'positions')=2 AND (o->>'rollCount')::int=2 AND (o->>'withoutVoucher')::int=2 AND o->>'status'='DRAFT' AND NOT (o->>'electionKeySet')::boolean, 'overview counts';
  ASSERT jsonb_array_length(o->'positions'->0->'candidates')=2, 'candidates listed under their position';
  BEGIN PERFORM admin.setup_overview(c.e,c.b); ASSERT false,'other org must be refused'; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='FORBIDDEN','other org: '||SQLERRM; END;
  BEGIN PERFORM admin.set_window(c.e,c.a,now()+interval '2 days',now()+interval '1 day'); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='GATE:BAD_WINDOW','closing before opening is refused'; END;
  BEGIN PERFORM admin.set_window(c.e,c.a,now()-interval '3 days',now()-interval '2 days'); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='GATE:BAD_WINDOW','a window already over is refused'; END;
  BEGIN PERFORM admin.set_window(c.e,c.b,now()+interval '1 day',now()+interval '2 days'); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='FORBIDDEN','other org cannot set times'; END;
  PERFORM admin.set_window(c.e,c.a,now()+interval '1 day',now()+interval '2 days'); ASSERT (admin.setup_overview(c.e,c.a)->>'opensAt') IS NOT NULL,'times saved';
  PERFORM admin.remove_candidate(c.e,c.a,c1); ASSERT jsonb_array_length(admin.setup_overview(c.e,c.a)->'positions'->0->'candidates')=1,'candidate removed';
  BEGIN PERFORM admin.remove_candidate(c.e,c.a,c1); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='NOT_FOUND','removing twice is NOT_FOUND'; END;
  PERFORM admin.remove_position(c.e,c.a,p1); ASSERT jsonb_array_length(admin.setup_overview(c.e,c.a)->'positions')=1,'position (and its candidates) removed';
  PERFORM admin.store_vouchers(c.e,c.a,(SELECT jsonb_agg(jsonb_build_object('voter_id',id,'hash',encode(sha256(id::text::bytea),'hex'))) FROM election.voters WHERE election_id=c.e),7);
  BEGIN PERFORM admin.clear_roll(c.e,c.a); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='GATE:VOUCHERS_ISSUED','roll cannot be cleared once vouchers exist'; END;
  UPDATE election.elections SET status='LOCKED' WHERE id=c.e;
  BEGIN PERFORM admin.remove_position(c.e,c.a,p2); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='GATE:LOCKED','no removals after the lock'; END;
  PERFORM admin.set_window(c.e,c.a,now()+interval '1 day',now()+interval '3 days');   -- times may still move while LOCKED
  UPDATE election.elections SET status='OPEN' WHERE id=c.e;
  BEGIN PERFORM admin.set_window(c.e,c.a,now()+interval '1 day',now()+interval '3 days'); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='GATE:BAD_STATE','no time changes once open'; END;
END $$;
ROLLBACK;
