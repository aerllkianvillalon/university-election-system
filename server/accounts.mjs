// Staff account lifecycle over HTTP: setup with a one-time code, password and authenticator changes, recovery codes, and the people queue.
// Secrets are shown once and stored only as hashes (setup and recovery codes) or sealed with STAFF_KEY (authenticator secrets).
import { hash, verify } from '@node-rs/argon2';
import { totp, step, seal, open } from './totp.mjs';

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O/1/I: these are read aloud and typed by hand
export const norm = (v) => String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) { let bits = 0, v = 0, out = ''; for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; v &= (1 << bits) - 1; } } if (bits > 0) out += B32[(v << (5 - bits)) & 31]; return out; }

import nodeCrypto from 'node:crypto';
const hmac = (k, v) => nodeCrypto.createHmac('sha256', k).update(v).digest();   // same as `hm` in index.mjs
export function pick(n, crypto = nodeCrypto) { let out = ''; while (out.length < n) for (const b of crypto.randomBytes(n * 2)) { if (b < 248 && out.length < n) out += ALPHA[b % 31]; } return out; }   // 248 = 31 * 8: no modulo bias
export function generateSetupCode(pepper) { const c = pick(12); return { code: `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`, hash: hmac(pepper, 'setup:' + c) }; }
export function mountAccounts(app, d, h) {
  const { pool, hm, str, allow, tooMany, crypto, sleepTo, FAIL, sha } = d;
  const { KEY, requireStaff, run, q1, me, bad, cookies } = h, PEPPER = process.env.PEPPER;
  const newSetupCode = () => generateSetupCode(PEPPER);
  const newRecovery = () => Array.from({ length: 10 }, () => { const c = pick(10, crypto); return { code: `${c.slice(0, 5)}-${c.slice(5)}`, hash: hm(PEPPER, 'recovery:' + c) }; });
  const setupHash = (c) => hm(PEPPER, 'setup:' + norm(c));
  const goodPassword = (p) => typeof p === 'string' && p.length >= 12 && p.length <= 128;
  const matchStep = (secret, code, last) => { const now = step(); for (const st of [now - 1, now, now + 1]) if (st > Number(last) && totp(secret, st) === code) return st; return null; };
  const newSecret = () => { const s = crypto.randomBytes(20); return { raw: s, sealed: seal(KEY, s), text: base32(s) }; };
  const uri = (username, text) => `otpauth://totp/CTU%20Vote:${encodeURIComponent(username)}?secret=${text}&issuer=CTU%20Vote&algorithm=SHA1&digits=6&period=30`;
  const BAD_PASSWORD = { error: { code: 'PASSWORD_TOO_SHORT', message: 'Use at least 12 characters for your password.' } };
  const S = requireStaff('ADMIN', 'PROCTOR', 'OBSERVER'), A = requireStaff('ADMIN');

  // ---- setup (public; every failure looks the same) ----
  const setupGate = async (req, res) => {
    const b = req.body || {};
    if (!(await allow(`setup:ip:${req.ip}`, 30, 3600))) { tooMany(res); return null; }
    if (str(b.username, 32) && !(await allow(`setup:${b.username}`, 10, 900))) { tooMany(res); return null; }
    return b; };
  app.post('/api/staff/setup/start', async (req, res) => { const t0 = Date.now(), b = await setupGate(req, res); if (!b) return; let out = null;
    if (str(b.username, 32) && str(b.setupCode, 40)) { const info = (await pool.query('SELECT admin.setup_peek($1,$2) AS i', [b.username, setupHash(b.setupCode)])).rows[0].i;
      if (info) { const s = newSecret(); if ((await pool.query('SELECT admin.setup_stage($1,$2,$3) AS ok', [b.username, setupHash(b.setupCode), s.sealed])).rows[0].ok) out = { name: info.name, role: info.role, secret: s.text, uri: uri(b.username, s.text) }; } }
    await sleepTo(t0, 500); out ? res.json(out) : res.status(400).json(FAIL); });
  app.post('/api/staff/setup/finish', async (req, res) => { const t0 = Date.now(), b = await setupGate(req, res); if (!b) return;
    if (!goodPassword(b.password)) return res.status(400).json(BAD_PASSWORD);
    let out = null;
    if (str(b.username, 32) && str(b.setupCode, 40) && /^\d{6}$/.test(String(b.code))) {
      const sealed = (await pool.query('SELECT admin.setup_pending($1,$2) AS p', [b.username, setupHash(b.setupCode)])).rows[0].p;
      const st = sealed ? matchStep(open(KEY, sealed), String(b.code), 0) : null;
      if (st !== null) { const rec = newRecovery();
        if ((await pool.query('SELECT admin.setup_complete($1,$2,$3,$4,$5) AS ok', [b.username, setupHash(b.setupCode), await hash(b.password), st, rec.map((r) => r.hash)])).rows[0].ok) out = { ok: true, recoveryCodes: rec.map((r) => r.code) }; } }
    await sleepTo(t0, 500); out ? res.json(out) : res.status(400).json(FAIL); });

  // ---- your own account (any signed-in staff) ----
  const own = async (req, res) => {   // current password check shared by every sensitive self-service action
    if (!(await allow(`acct:${me(req)}`, 10, 900))) { tooMany(res); return null; }
    const cred = (await pool.query('SELECT * FROM admin.staff_credentials($1)', [me(req)])).rows[0], pw = req.body?.current ?? req.body?.password;
    if (!cred || typeof pw !== 'string' || !(await verify(cred.password_hash, pw).catch(() => false))) { res.status(400).json({ error: { code: 'WRONG_PASSWORD', message: 'That is not your current password.' } }); return null; }
    return cred; };
  app.post('/api/staff/password', S, async (req, res) => { const cred = await own(req, res); if (!cred) return; const next = req.body?.next;
    if (!goodPassword(next)) return res.status(400).json(BAD_PASSWORD);
    if (next === (req.body.current)) return res.status(400).json({ error: { code: 'PASSWORD_UNCHANGED', message: 'Choose a different password.' } });
    await pool.query('SELECT admin.change_password($1,$2,$3)', [me(req), await hash(next), sha(cookies(req).ssid)]); res.json({ ok: true }); });
  app.post('/api/staff/authenticator/start', S, async (req, res) => { const cred = await own(req, res); if (!cred) return; const s = newSecret();
    await pool.query('SELECT admin.stage_authenticator($1,$2)', [me(req), s.sealed]); res.json({ secret: s.text, uri: uri(cred.username, s.text) }); });
  app.post('/api/staff/authenticator/confirm', S, async (req, res) => {
    if (!(await allow(`acct:${me(req)}`, 10, 900))) return tooMany(res);
    const cred = (await pool.query('SELECT * FROM admin.staff_credentials($1)', [me(req)])).rows[0], code = String(req.body?.code ?? '');
    const st = cred?.pending_totp && /^\d{6}$/.test(code) ? matchStep(open(KEY, cred.pending_totp), code, cred.totp_last_step) : null;
    if (st === null || !(await pool.query('SELECT admin.confirm_authenticator($1,$2,$3) AS ok', [me(req), st, sha(cookies(req).ssid)])).rows[0].ok) return res.status(400).json({ error: { code: 'BAD_CODE', message: 'That code did not match. Check your authenticator app and try again.' } });
    res.json({ ok: true }); });
  app.post('/api/staff/recovery-codes', S, async (req, res) => { if (!(await own(req, res))) return; const rec = newRecovery();
    await pool.query('SELECT admin.replace_recovery_codes($1,$2)', [me(req), rec.map((r) => r.hash)]); res.json({ recoveryCodes: rec.map((r) => r.code) }); });

  // ---- people (administrators only) ----
  app.get('/api/admin/staff', A, run(async (req) => (await q1('SELECT admin.staff_directory($1) AS d', [me(req)])).d));
  const ask = (action) => async (req, res) => { const b = req.body || {}, sc = newSetupCode();
    const params = action === 'invite' ? { name: b.name, username: b.username, role: b.role } : { staffId: req.params.id };
    if (action === 'invite' && !(str(b.name, 80) && str(b.username, 32) && str(b.role, 16))) return bad(res);
    return run(async () => { const r = (await q1('SELECT admin.staff_request($1,$2,$3,$4,$5) AS r', [me(req), action, params, sc.hash, 3])).r;
      return r.pending ? r : { ...r, ...(action !== 'disable' ? { setupCode: sc.code, validDays: 3 } : {}) }; })(req, res); };
  app.post('/api/admin/staff/invite', A, ask('invite'));
  app.post('/api/admin/staff/:id/disable', A, ask('disable'));
  app.post('/api/admin/staff/:id/reinvite', A, ask('reinvite'));
  app.post('/api/admin/staff-requests/:id/approve', A, run(async (req) => { const sc = newSetupCode();
    const r = (await q1('SELECT admin.staff_request_approve($1,$2,$3,$4) AS r', [req.params.id, me(req), sc.hash, 3])).r;
    return r.action === 'disable' ? r : { ...r, setupCode: sc.code, validDays: 3 }; }));
  app.post('/api/admin/staff-requests/:id/cancel', A, run(async (req) => { await q1('SELECT admin.staff_request_cancel($1,$2)', [req.params.id, me(req)]); return { ok: true }; }));
}
