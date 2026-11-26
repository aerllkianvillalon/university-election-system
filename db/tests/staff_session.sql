-- psql -v ON_ERROR_STOP=1 -f db/tests/staff_session.sql   (after all migrations; rolls back, leaves nothing behind)
BEGIN;
INSERT INTO org.organizations(slug,name) VALUES('sess-t','T');
INSERT INTO admin.admins(org_id,name,username,role,password_hash,totp_secret) SELECT id,'A','sess-a','ADMIN','x','\x00' FROM org.organizations WHERE slug='sess-t';
INSERT INTO admin.staff_sessions(id_hash,staff_id,mfa_verified,expires_at,started_at) SELECT v.h,a.id,v.mfa,now()+v.remain,now()-v.age FROM admin.admins a,
  (VALUES ('\x01'::bytea,true,interval '2 minutes',interval '0'),('\x02',false,interval '2 minutes',interval '0'),('\x03',true,interval '2 minutes',interval '7 hours 58 minutes'),('\x04',true,interval '-1 minute',interval '1 hour')) v(h,mfa,remain,age) WHERE a.username='sess-a';
DO $$ DECLARE e timestamptz; BEGIN
  e := admin.staff_session_extend('\x01'); ASSERT e > now() + interval '14 minutes' AND e <= now() + interval '15 minutes', 'extends by 15 minutes';
  ASSERT admin.staff_session_extend('\x02') IS NULL, 'a session without the authenticator step cannot be extended';
  e := admin.staff_session_extend('\x03'); ASSERT e <= now() + interval '2 minutes 5 seconds', 'never past 8 hours in total';
  ASSERT admin.staff_session_extend('\x04') IS NULL, 'an ended session cannot be revived';
  ASSERT admin.staff_session_expiry('\x02') IS NULL, 'expiry is only reported for a fully signed-in session';
END $$;
ROLLBACK;
