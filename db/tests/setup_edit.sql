-- psql -v ON_ERROR_STOP=1 -f db/tests/setup_edit.sql   (after all migrations; rolls back, leaves nothing behind)
BEGIN;
INSERT INTO org.organizations(slug,name) VALUES('se-a','A'),('se-b','B');
INSERT INTO admin.admins(org_id,name,username,role,password_hash,totp_secret) SELECT id,'A','se-admin-a','ADMIN','x','\x00' FROM org.organizations WHERE slug='se-a';
INSERT INTO admin.admins(org_id,name,username,role,password_hash,totp_secret) SELECT id,'B','se-admin-b','ADMIN','x','\x00' FROM org.organizations WHERE slug='se-b';
INSERT INTO election.elections(org_id) SELECT id FROM org.organizations WHERE slug='se-a';
CREATE TEMP TABLE ctx AS SELECT (SELECT e.id FROM election.elections e JOIN org.organizations o ON o.id=e.org_id WHERE o.slug='se-a') AS e,
  (SELECT id FROM admin.admins WHERE username='se-admin-a') AS a, (SELECT id FROM admin.admins WHERE username='se-admin-b') AS b;
GRANT ALL ON ctx TO PUBLIC;
DO $$ DECLARE c ctx%ROWTYPE; p1 uuid; p2 uuid; c1 uuid; o jsonb; jpg bytea := '\xffd8ff'::bytea || decode(repeat('00',200),'hex'); BEGIN SELECT * INTO c FROM ctx;
  -- scope validation
  ASSERT admin.valid_scope('{"all":true}') AND admin.valid_scope('{"match":{"program":"BSIT"}}') AND admin.valid_scope('{"match":{"program":"BSIT","year":"3"}}'), 'good scopes';
  ASSERT NOT admin.valid_scope('{}') AND NOT admin.valid_scope('{"match":{}}') AND NOT admin.valid_scope('{"match":{"a":1}}') AND NOT admin.valid_scope('{"all":false}') AND NOT admin.valid_scope('{"match":{"a":"b"},"all":true}') AND NOT admin.valid_scope('[]') AND NOT admin.valid_scope(NULL), 'bad scopes';
  BEGIN PERFORM admin.add_position(c.e,c.a,'X',1,0,true,'{"match":{}}'); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='GATE:BAD_SCOPE','add_position refuses a bad scope'; END;
  p1 := admin.add_position(c.e,c.a,'President',1,0,true,'{"all":true}'); p2 := admin.add_position(c.e,c.a,'BSIT Rep',2,1,true,'{"match":{"program":"BSIT"}}');
  c1 := admin.add_candidate(c.e,c.a,p1,'Ana',NULL);
  PERFORM admin.import_roll(c.e,c.a,'[{"studentId":"1","channel":"ONLINE","attrs":{"program":"BSIT","year":"1"}},{"studentId":"2","channel":"ONLINE","attrs":{"program":"BSCS","year":"1"}},{"studentId":"3","channel":"ONLINE","attrs":{"program":"BSIT","year":"2"}}]');
  o := admin.setup_overview(c.e,c.a);
  ASSERT (o->'attributes'->'program') = '["BSCS","BSIT"]'::jsonb AND (o->'attributes'->'year') = '["1","2"]'::jsonb, 'attribute values listed: '||o::text;
  ASSERT (SELECT (x->>'eligible')::int FROM jsonb_array_elements(o->'positions') x WHERE x->>'title'='President')=3 AND (SELECT (x->>'eligible')::int FROM jsonb_array_elements(o->'positions') x WHERE x->>'title'='BSIT Rep')=2, 'eligible counts follow the scope';
  -- the ballot really follows it (voter 2 is BSCS: only President)
  ASSERT (SELECT count(*) FROM election.voter_contests(c.e,(SELECT id FROM election.voters WHERE election_id=c.e AND student_id='2')))=1 AND (SELECT count(*) FROM election.voter_contests(c.e,(SELECT id FROM election.voters WHERE election_id=c.e AND student_id='1')))=2, 'ballot scope';
  -- edit position
  PERFORM admin.update_position(c.e,c.a,p2,'BSIT Representative',1,false,'{"match":{"program":"BSIT","year":"2"}}');
  o := admin.setup_overview(c.e,c.a); ASSERT (SELECT (x->>'eligible')::int FROM jsonb_array_elements(o->'positions') x WHERE x->>'title'='BSIT Representative')=1 AND (SELECT (x->>'seats')::int FROM jsonb_array_elements(o->'positions') x WHERE x->>'title'='BSIT Representative')=1 AND (SELECT min_sel FROM election.positions WHERE id=p2)=1, 'position edited, min_sel kept within seats';
  BEGIN PERFORM admin.update_position(c.e,c.a,p2,'',1,true,'{"all":true}'); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='GATE:BAD_DETAILS','empty title refused'; END;
  BEGIN PERFORM admin.update_position(c.e,c.a,p2,'T',1,true,'{"x":1}'); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='GATE:BAD_SCOPE','bad scope refused on edit'; END;
  BEGIN PERFORM admin.update_position(c.e,c.b,p2,'T',1,true,'{"all":true}'); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='FORBIDDEN','other org refused'; END;
  -- edit candidate
  PERFORM admin.update_candidate(c.e,c.a,c1,'Ana Reyes','Free printing'); ASSERT (SELECT name||'|'||platform FROM election.candidates WHERE id=c1)='Ana Reyes|Free printing','candidate edited';
  BEGIN PERFORM admin.update_candidate(c.e,c.a,c1,'',NULL); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='GATE:BAD_DETAILS','empty name refused'; END;
  -- photos
  BEGIN PERFORM admin.set_candidate_photo(c.e,c.a,c1,'\x89504e47'::bytea || decode(repeat('00',200),'hex')); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='GATE:BAD_PHOTO','a PNG is refused (JPEG only)'; END;
  BEGIN PERFORM admin.set_candidate_photo(c.e,c.a,c1,'\xffd8ff'::bytea || decode(repeat('00',300000),'hex')); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='GATE:BAD_PHOTO','over 256 KB refused'; END;
  BEGIN PERFORM admin.set_candidate_photo(c.e,c.b,c1,jpg); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='FORBIDDEN','other org refused'; END;
  PERFORM admin.set_candidate_photo(c.e,c.a,c1,jpg); ASSERT length(admin.candidate_photo(c.e,c.a,c1))=203 AND (admin.setup_overview(c.e,c.a)->'positions'->0->'candidates'->0->>'hasPhoto')::boolean,'photo saved and flagged';
  ASSERT election.candidate_photo_public(c.e,c1) IS NULL, 'not public while drafting';
  BEGIN PERFORM admin.candidate_photo(c.e,c.b,c1); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='FORBIDDEN','other org cannot read the draft photo'; END;
  PERFORM admin.clear_candidate_photo(c.e,c.a,c1); ASSERT admin.candidate_photo(c.e,c.a,c1) IS NULL,'photo cleared'; PERFORM admin.set_candidate_photo(c.e,c.a,c1,jpg);
  UPDATE election.elections SET status='LOCKED' WHERE id=c.e;
  ASSERT length(election.candidate_photo_public(c.e,c1))=203, 'public once locked'; ASSERT (SELECT count(*) FROM election.candidates_with_photo(ARRAY[c1]))=1, 'photo flag lookup';
  UPDATE election.candidates SET withdrawn_at=now() WHERE id=c1; ASSERT election.candidate_photo_public(c.e,c1) IS NULL,'withdrawn candidate has no public photo'; UPDATE election.candidates SET withdrawn_at=NULL WHERE id=c1;
  BEGIN PERFORM admin.update_candidate(c.e,c.a,c1,'Z',NULL); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='GATE:LOCKED','no edits after the lock'; END;
  BEGIN PERFORM admin.set_candidate_photo(c.e,c.a,c1,jpg); ASSERT false; EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='GATE:LOCKED','no photo changes after the lock'; END;
  UPDATE election.elections SET status='DRAFT' WHERE id=c.e; PERFORM admin.remove_candidate(c.e,c.a,c1); ASSERT NOT EXISTS (SELECT 1 FROM election.candidate_photos WHERE candidate_id=c1),'photo goes with its candidate';
END $$;
ROLLBACK;
