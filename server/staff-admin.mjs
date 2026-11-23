// Appoint the first administrators of an organization, and the break-glass for a locked-out organization. Run on a machine with OWNER access to the
// database (never from the web server). Nothing here can sign anyone in: it only creates an account that has no password yet, and prints a one-time
// setup code. The person opens /staff/setup, chooses their own password and scans their own authenticator.
//   DATABASE_URL=postgresql://owner@host/db PEPPER=... node server/staff-admin.mjs create-org  --name "BS IT Society" --slug bsit
//   ...                                                   node server/staff-admin.mjs invite      --org bsit --username maria --name "Maria Santos" --role ADMIN [--days 2]
//   ...                                                   node server/staff-admin.mjs reinvite    --username maria [--days 2]      (lost phone and recovery codes, nobody left to approve)
//   ...                                                   node server/staff-admin.mjs disable     --username maria                  (break-glass; recorded in the audit log)
import pg from 'pg'; import { generateSetupCode } from './accounts.mjs';
const [cmd, ...rest] = process.argv.slice(2), a = {}; for (let i = 0; i < rest.length; i += 2) a[rest[i].replace(/^--/, '')] = rest[i + 1];
const die = (m) => { console.error(m); process.exit(1); };
if (!process.env.DATABASE_URL || !process.env.PEPPER) die('DATABASE_URL (owner) and PEPPER are required');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const days = Math.min(Math.max(parseInt(a.days ?? '2', 10) || 2, 1), 14);
const show = (c, username) => console.log(`\nSetup code for ${username}: ${c.code}\nValid for ${days} day(s), works once. Give it to ${username} in person, then they open /staff/setup.\n`);
try {
  if (cmd === 'create-org') { if (!a.name || !/^[a-z0-9-]{2,40}$/.test(a.slug ?? '')) die('usage: create-org --name <name> --slug <lowercase-slug>');
    await db.query('INSERT INTO org.organizations(slug, name) VALUES ($1, $2)', [a.slug, a.name]); console.log(`OK organization ${a.slug} created`); }
  else if (cmd === 'invite') { const org = (await db.query('SELECT id FROM org.organizations WHERE slug = $1', [a.org])).rows[0]; if (!org) die('no such organization');
    const c = generateSetupCode(process.env.PEPPER); await db.query('SELECT admin.invite_staff($1, NULL, $2, $3, $4, $5, $6)', [org.id, a.name, a.username, a.role ?? 'ADMIN', c.hash, days]); show(c, a.username); }
  else if (cmd === 'reinvite') { const t = (await db.query('SELECT id, org_id FROM admin.admins WHERE username = $1', [a.username])).rows[0]; if (!t) die('no such account');
    const c = generateSetupCode(process.env.PEPPER);
    await db.query('BEGIN'); await db.query("DELETE FROM admin.staff_sessions WHERE staff_id = $1", [t.id]); await db.query("DELETE FROM admin.recovery_codes WHERE admin_id = $1", [t.id]); await db.query("DELETE FROM admin.setup_codes WHERE admin_id = $1", [t.id]);
    await db.query("UPDATE admin.admins SET status = 'INVITED', password_hash = NULL, totp_secret = NULL, pending_totp = NULL, totp_last_step = 0 WHERE id = $1", [t.id]);
    await db.query("INSERT INTO admin.setup_codes(admin_id, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))", [t.id, c.hash, days]);
    await db.query("INSERT INTO ops.audit(action, detail) VALUES ('STAFF_REINVITE_BREAK_GLASS', $1)", [{ staff_id: t.id }]); await db.query('COMMIT'); show(c, a.username); }
  else if (cmd === 'disable') { const t = (await db.query('SELECT id FROM admin.admins WHERE username = $1', [a.username])).rows[0]; if (!t) die('no such account');
    await db.query('BEGIN'); await db.query("DELETE FROM admin.staff_sessions WHERE staff_id = $1", [t.id]); await db.query("UPDATE admin.admins SET status = 'DISABLED' WHERE id = $1", [t.id]);
    await db.query("INSERT INTO ops.audit(action, detail) VALUES ('STAFF_DISABLE_BREAK_GLASS', $1)", [{ staff_id: t.id }]); await db.query('COMMIT'); console.log(`OK ${a.username} disabled`); }
  else die('usage: create-org | invite | reinvite | disable (see the comments at the top of this file)');
} catch (e) { await db.query('ROLLBACK').catch(() => {}); die(String(e.message).replace(/^GATE:/, 'refused: ')); } finally { await db.end(); }
