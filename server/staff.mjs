// Staff (admin/proctor/observer): password + TOTP login, then admin controls. Org membership and two-admin rules are enforced by the SQL functions.
import { totp, step, open } from './totp.mjs';
import { mountAccounts, norm } from './accounts.mjs';
export function mountStaff(app, d) {
  const { pool, sha, hm, cookies, setCookie, str, allow, tooMany, verify, DUMMY, crypto, sleepTo, FAIL, sodium } = d;
  const KEY = Buffer.from(process.env.STAFF_KEY || '', 'hex'); if (KEY.length !== 32) throw new Error('STAFF_KEY must be 64 hex characters');
  const deny = (res, code, status = 401) => res.status(status).json({ error: { code, message: code === 'MFA_REQUIRED' ? 'Sign in with your authenticator code.' : 'Not allowed.' } });
  const requireStaff = (...roles) => async (req, res, next) => {
    const sid = cookies(req).ssid; const s = sid && (await pool.query('SELECT * FROM admin.staff_session($1)', [sha(sid)])).rows[0];
    if (!s || !s.mfa_verified) return deny(res, 'MFA_REQUIRED'); if (!roles.includes(s.role)) return deny(res, 'FORBIDDEN', 403); req.staff = s; next(); };
  const dbErr = (res, e) => { const m = String(e.message); const code = m.startsWith('GATE:') ? 'GATE_' + m.slice(5) : m;
    if (code === 'FORBIDDEN') return deny(res, 'FORBIDDEN', 403);
    if (code.startsWith('GATE_') || ['SAME_ADMIN', 'SAME_ADMIN_OR_BAD_STATE', 'NOT_FOUND'].includes(code)) return res.status(409).json({ error: { code, message: 'That action is not allowed right now.' } });
    console.error(e); return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong.' } }); };
  app.post('/api/staff/login', async (req, res) => {
    const t0 = Date.now(), b = req.body || {}; let sid = null;
    if (!(await allow(`staff:ip:${req.ip}`, 30, 300)) || !(await allow(`staff:${String(b.username)}`, 5, 900))) return tooMany(res);
    try { if (str(b.username, 64) && str(b.password)) { const r = (await pool.query('SELECT * FROM admin.staff_by_username($1)', [b.username])).rows[0];
        const good = await verify(r?.password_hash ?? DUMMY, b.password).catch(() => false);
        if (r && good && r.totp_secret) { sid = crypto.randomBytes(32).toString('base64url'); await pool.query('SELECT admin.staff_open_session($1,$2)', [sha(sid), r.id]); } } } catch (e) { sid = null; }
    await sleepTo(t0, 500); if (!sid) return res.status(401).json(FAIL); setCookie(res, 'ssid', sid, 900); res.json({ mfaRequired: true }); });
  app.post('/api/staff/mfa', async (req, res) => {
    const sid = cookies(req).ssid, rc = req.body?.recoveryCode, code = String(req.body?.code ?? ''); if (!sid || (typeof rc !== 'string' && !/^\d{6}$/.test(code))) return deny(res, 'MFA_REQUIRED');
    if (!(await allow(`mfa:${sha(sid).toString('hex')}`, 5, 300))) return tooMany(res);
    if (typeof rc === 'string') { const ok = rc.length <= 32 && (await pool.query('SELECT admin.use_recovery_code($1,$2) AS ok', [sha(sid), hm(process.env.PEPPER, 'recovery:' + norm(rc))])).rows[0].ok;   // each code works once; the session is marked "recovered"
      return ok ? res.json({ ok: true, recovered: true }) : deny(res, 'MFA_REQUIRED'); }
    const r = (await pool.query('SELECT * FROM admin.staff_session_secret($1)', [sha(sid)])).rows[0]; if (!r) return deny(res, 'MFA_REQUIRED');
    const secret = open(KEY, r.totp_secret), now = step(); let ok = false;
    for (const st of [now - 1, now, now + 1]) if (st > Number(r.totp_last_step) && totp(secret, st) === code) { ok = (await pool.query('SELECT admin.staff_mfa_ok($1,$2) AS ok', [sha(sid), st])).rows[0].ok; break; }
    ok ? res.json({ ok: true }) : deny(res, 'MFA_REQUIRED'); });
  app.param('id', (req, res, next, id) => /^[0-9a-f-]{36}$/i.test(id) ? next() : res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }));   // a malformed id is a 404, never a database error
  const A = requireStaff('ADMIN');
  app.get('/api/admin/elections/:id/turnout', A, async (req, res) => { try { res.json((await pool.query('SELECT admin.turnout($1,$2) AS t', [req.params.id, req.staff.staff_id])).rows[0].t); } catch (e) { dbErr(res, e); } });
  app.post('/api/admin/elections/:id/actions', A, async (req, res) => { const { action, params } = req.body || {};
    try { res.json({ approvalId: (await pool.query('SELECT admin.request_action($1,$2,$3,$4) AS id', [req.params.id, String(action), params ?? {}, req.staff.staff_id])).rows[0].id }); } catch (e) { dbErr(res, e); } });
  app.post('/api/admin/approvals/:id/approve', A, async (req, res) => { try { await pool.query('SELECT admin.approve($1,$2)', [req.params.id, req.staff.staff_id]); res.json({ ok: true }); } catch (e) { dbErr(res, e); } });
  app.post('/api/admin/elections/:id/freeze', A, async (req, res) => { try { await pool.query('SELECT admin.freeze($1,$2)', [req.params.id, req.staff.staff_id]); res.json({ ok: true }); } catch (e) { dbErr(res, e); } });
  app.post('/api/admin/elections/:id/ratify-freeze', A, async (req, res) => { try { await pool.query('SELECT admin.ratify_freeze($1,$2)', [req.params.id, req.staff.staff_id]); res.json({ ok: true }); } catch (e) { dbErr(res, e); } });
  // ---- election management (all org-scoped and edit-locked in SQL) ----
  const q1 = async (sql, args) => (await pool.query(sql, args)).rows[0], me = (req) => req.staff.staff_id;
  const run = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { dbErr(res, e); } };
  const bad = (res) => res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Invalid request.' } });
  // Online-only unless the lab is enabled: a missing channel means ONLINE, and a LAB voter is refused (nobody could vote at a booth that does not exist).
  app.post('/api/admin/elections/:id/roll', A, async (req, res) => { let rows = req.body?.rows;
    if (!d.LAB_ENABLED && Array.isArray(rows)) { if (rows.some((r) => r && r.channel === 'LAB')) return res.status(400).json({ error: { code: 'LAB_DISABLED', message: 'In-lab voting is not enabled, so every voter must use the online channel.' } });
      rows = rows.map((r) => (r && typeof r === 'object' && (r.channel === undefined || r.channel === null || r.channel === '') ? { ...r, channel: 'ONLINE' } : r)); }
    return run(async (r) => (await q1('SELECT admin.import_roll($1,$2,$3) AS r', [r.params.id, me(r), JSON.stringify(rows ?? null)])).r)(req, res); });
  app.post('/api/admin/elections/:id/positions', A, async (req, res) => { const b = req.body || {};
    if (!str(b.title, 120) || !Number.isInteger(b.seats) || b.seats < 1 || b.seats > 20 || !Number.isInteger(b.minSelections ?? 0) || !scopeOk(b.scope ?? { all: true })) return bad(res);
    return run(async (r) => ({ id: (await q1('SELECT admin.add_position($1,$2,$3,$4,$5,$6,$7) AS id', [r.params.id, me(r), b.title, b.seats, b.minSelections ?? 0, b.allowAbstain ?? true, b.scope ?? { all: true }])).id }))(req, res); });
  app.post('/api/admin/elections/:id/candidates', A, async (req, res) => { const b = req.body || {}; if (!str(b.positionId, 36) || !str(b.name, 120) || (b.platform != null && !str(b.platform, 1000))) return bad(res);
    return run(async (r) => ({ id: (await q1('SELECT admin.add_candidate($1,$2,$3,$4,$5) AS id', [r.params.id, me(r), b.positionId, b.name, b.platform ?? null])).id }))(req, res); });
  app.post('/api/admin/elections/:id/key', A, async (req, res) => { const k = Buffer.from(String(req.body?.publicKey ?? ''), 'base64'); if (k.length !== 32) return bad(res);
    return run(async (r) => { await q1('SELECT admin.set_election_key($1,$2,$3)', [r.params.id, me(r), k]); return { ok: true, fingerprint: d.sha(k).toString('hex').slice(0, 16) }; })(req, res); });
  // Voucher codes are shown ONCE, here; only salted HMACs are stored.
  app.post('/api/admin/elections/:id/vouchers/generate', A, run(async (req) => {
    const rows = (await pool.query('SELECT * FROM admin.voters_without_voucher($1,$2)', [req.params.id, me(req)])).rows;
    const out = rows.map((r) => { const code = crypto.randomBytes(5).toString('hex').toUpperCase(); return { voter_id: r.voter_id, studentId: r.student_id, code, hash: hm(process.env.PEPPER, code).toString('hex') }; });
    if (out.length) await q1('SELECT admin.store_vouchers($1,$2,$3,7)', [req.params.id, me(req), JSON.stringify(out.map((o) => ({ voter_id: o.voter_id, hash: o.hash })))]);
    return { issued: out.length, vouchers: out.map((o) => ({ studentId: o.studentId, code: o.code })) }; }));
  // Console support: who am I, the approval queue, withdrawing a request, signing out.
  const S = requireStaff('ADMIN', 'PROCTOR');
  app.get('/api/staff/me', S, run(async (req) => ({ ...(await q1('SELECT admin.staff_overview($1) AS o', [me(req)])).o, recoveryCodesLeft: (await q1('SELECT admin.recovery_codes_left($1) AS n', [me(req)])).n, recovered: (await q1('SELECT admin.session_recovered($1) AS r', [sha(cookies(req).ssid)])).r })));
  app.get('/api/staff/session', S, run(async (req) => ({ expiresAt: (await q1('SELECT admin.staff_session_expiry($1) AS e', [sha(cookies(req).ssid)])).e })));   // lets the console warn before the session ends
  app.post('/api/staff/session/extend', S, async (req, res) => {   // 15 more minutes, never past 8 hours in total (SQL enforces the cap)
    try { const e = (await q1('SELECT admin.staff_session_extend($1) AS e', [sha(cookies(req).ssid)])).e; if (!e) return deny(res, 'MFA_REQUIRED'); setCookie(res, 'ssid', cookies(req).ssid, 900); res.json({ expiresAt: e }); } catch (err) { dbErr(res, err); } });
  app.post('/api/staff/logout', async (req, res) => { const sid = cookies(req).ssid; try { if (sid) await pool.query('SELECT admin.staff_close_session($1)', [sha(sid)]); } catch (e) { console.error(e); }
    setCookie(res, 'ssid', '', 0); res.json({ ok: true }); });   // idempotent, and the session is deleted on the server, not just forgotten by the browser
  app.get('/api/admin/elections/:id/approvals', A, run(async (req) => (await q1('SELECT admin.pending_approvals($1,$2) AS a', [req.params.id, me(req)])).a));
  app.post('/api/admin/approvals/:id/cancel', A, run(async (req) => { await q1('SELECT admin.cancel_request($1,$2)', [req.params.id, me(req)]); return { ok: true }; }));
  // Results. The signing key is registered before voting (same rule as the election key); a signed tally is checked here, then against the database in SQL.
  app.post('/api/admin/elections/:id/signing-key', A, async (req, res) => { const k = Buffer.from(String(req.body?.publicKey ?? ''), 'base64'); if (k.length !== 32) return bad(res);
    return run(async (r) => { await q1('SELECT admin.set_signing_key($1,$2,$3)', [r.params.id, me(r), k]); return { ok: true, fingerprint: d.sha(k).toString('hex').slice(0, 16) }; })(req, res); });
  // Setup screens: what is set up so far, the voting times, and taking back a mistake (all refused after the lock in SQL).
  const uuid = (v) => /^[0-9a-f-]{36}$/i.test(String(v));
  app.get('/api/admin/elections/:id/setup', A, run(async (req) => (await q1('SELECT admin.setup_overview($1,$2) AS o', [req.params.id, me(req)])).o));
  app.post('/api/admin/elections/:id/window', A, async (req, res) => { const o = Date.parse(req.body?.opensAt), c = Date.parse(req.body?.closesAt);
    if (!Number.isFinite(o) || !Number.isFinite(c) || typeof req.body?.opensAt !== 'string' || typeof req.body?.closesAt !== 'string') return bad(res);
    return run(async (r) => { await q1('SELECT admin.set_window($1,$2,$3,$4)', [r.params.id, me(r), new Date(o).toISOString(), new Date(c).toISOString()]); return { ok: true }; })(req, res); });
  app.post('/api/admin/elections/:id/positions/:pid/remove', A, async (req, res) => { if (!uuid(req.params.pid)) return bad(res);
    return run(async (r) => { await q1('SELECT admin.remove_position($1,$2,$3)', [r.params.id, me(r), r.params.pid]); return { ok: true }; })(req, res); });
  app.post('/api/admin/elections/:id/candidates/:cid/remove', A, async (req, res) => { if (!uuid(req.params.cid)) return bad(res);
    return run(async (r) => { await q1('SELECT admin.remove_candidate($1,$2,$3)', [r.params.id, me(r), r.params.cid]); return { ok: true }; })(req, res); });
  const scopeOk = (v) => v && typeof v === 'object' && !Array.isArray(v) && (v.all === true && Object.keys(v).length === 1 || (Object.keys(v).length === 1 && v.match && typeof v.match === 'object' && !Array.isArray(v.match) && Object.keys(v.match).length >= 1 && Object.keys(v.match).length <= 3 && Object.values(v.match).every((x) => str(x, 80))));
  app.post('/api/admin/elections/:id/positions/:pid/edit', A, async (req, res) => { const b = req.body || {}; if (!uuid(req.params.pid) || !str(b.title, 120) || !Number.isInteger(b.seats) || b.seats < 1 || b.seats > 20 || typeof b.allowAbstain !== 'boolean' || !scopeOk(b.scope)) return bad(res);
    return run(async (r) => { await q1('SELECT admin.update_position($1,$2,$3,$4,$5,$6,$7)', [r.params.id, me(r), r.params.pid, b.title, b.seats, b.allowAbstain, b.scope]); return { ok: true }; })(req, res); });
  app.post('/api/admin/elections/:id/candidates/:cid/edit', A, async (req, res) => { const b = req.body || {}; if (!uuid(req.params.cid) || !str(b.name, 120) || (b.platform != null && !str(b.platform, 1000))) return bad(res);
    return run(async (r) => { await q1('SELECT admin.update_candidate($1,$2,$3,$4,$5)', [r.params.id, me(r), r.params.cid, b.name, b.platform ?? null]); return { ok: true }; })(req, res); });
  // Photos: the page sends a small JPEG as base64; SQL checks the size and the JPEG signature.
  app.post('/api/admin/elections/:id/candidates/:cid/photo', A, async (req, res) => { const img = req.body?.image; if (!uuid(req.params.cid) || typeof img !== 'string' || img.length > 360000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(img)) return bad(res);
    return run(async (r) => { await q1('SELECT admin.set_candidate_photo($1,$2,$3,$4)', [r.params.id, me(r), r.params.cid, Buffer.from(img, 'base64')]); return { ok: true }; })(req, res); });
  app.post('/api/admin/elections/:id/candidates/:cid/photo/remove', A, async (req, res) => { if (!uuid(req.params.cid)) return bad(res);
    return run(async (r) => { await q1('SELECT admin.clear_candidate_photo($1,$2,$3)', [r.params.id, me(r), r.params.cid]); return { ok: true }; })(req, res); });
  app.get('/api/admin/elections/:id/candidates/:cid/photo', A, async (req, res) => { if (!uuid(req.params.cid)) return bad(res);
    let d; try { d = (await q1('SELECT admin.candidate_photo($1,$2,$3) AS d', [req.params.id, me(req), req.params.cid])).d; } catch { return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }); }
    if (!d) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    res.set({ 'Content-Type': 'image/jpeg', 'Content-Length': String(d.length), 'Content-Security-Policy': "default-src 'none'; sandbox" }).end(d); });
  app.post('/api/admin/elections/:id/roll/clear', A, run(async (req) => ({ removed: (await q1('SELECT admin.clear_roll($1,$2) AS n', [req.params.id, me(req)])).n })));
  // Audit trail: newest first, only this organization's entries; the chain check recomputes every link.
  app.get('/api/admin/audit', A, async (req, res) => { const n = Number(req.query.limit ?? 50), before = req.query.before == null ? null : Number(req.query.before), act = req.query.action == null ? null : String(req.query.action);
    if (!Number.isInteger(n) || n < 1 || n > 200 || (before !== null && !Number.isInteger(before)) || (act !== null && !/^[A-Z_]{1,40}$/.test(act))) return bad(res);
    return run(async (r) => ({ entries: (await q1('SELECT admin.audit_list($1,$2,$3,$4) AS l', [me(r), n, before, act])).l }))(req, res); });
  app.get('/api/admin/audit/check', A, run(async (req) => (await q1('SELECT admin.audit_check($1) AS c', [me(req)])).c));
  app.get('/api/admin/elections/:id/results', A, run(async (req) => (await q1('SELECT admin.results_status($1,$2) AS s', [req.params.id, me(req)])).s));
  app.post('/api/admin/elections/:id/results', A, async (req, res) => { const r = req.body?.results;   // the file `ev tally` wrote: {body, signature}
    if (!r || typeof r.body !== 'string' || r.body.length > 20000 || typeof r.signature !== 'string') return bad(res);
    let chain, sig; try { chain = JSON.parse(r.body).chain; sig = Buffer.from(r.signature, 'base64'); } catch { return bad(res); }
    if (typeof chain !== 'string' || !chain || chain.length > 64 || sig.length !== 64) return bad(res);
    return run(async (rq) => {
      const key = (await q1('SELECT admin.signing_key_of($1,$2) AS k', [rq.params.id, me(rq)])).k; if (!key) throw new Error('GATE:NO_SIGNING_KEY');
      if (!sodium.crypto_sign_verify_detached(new Uint8Array(sig), new Uint8Array(sha(Buffer.from(r.body))), new Uint8Array(key))) throw new Error('GATE:BAD_SIGNATURE');
      return (await q1('SELECT admin.import_results($1,$2,$3,$4,$5) AS r', [rq.params.id, me(rq), chain, r.body, sig])).r; })(req, res); });
  // Support queue and in-person claim codes. Claim codes are shown ONCE here; only a salted HMAC is stored.
  app.get('/api/admin/elections/:id/support', A, run(async (req) => ({ requests: (await pool.query('SELECT * FROM admin.list_support($1,$2,$3,$4)', [req.params.id, me(req), req.query.status || null, req.query.kind || null])).rows })));
  app.post('/api/admin/support/:id/status', A, async (req, res) => { const b = req.body || {};
    if (!['IN_REVIEW', 'RESOLVED', 'DISMISSED'].includes(b.status) || !(b.note == null || (typeof b.note === 'string' && b.note.length <= 2000)) || !/^[0-9a-f-]{36}$/i.test(req.params.id)) return bad(res);
    return run(async (r) => { await q1('SELECT admin.update_support($1,$2,$3,$4)', [r.params.id, me(r), b.status, b.note ?? null]); return { ok: true }; })(req, res); });
  app.post('/api/admin/elections/:id/claim-codes', A, async (req, res) => { const sid = req.body?.studentId; if (!str(sid, 32)) return bad(res);
    return run(async (r) => { const code = crypto.randomBytes(5).toString('hex').toUpperCase();
      const ok = (await q1('SELECT admin.issue_claim_code($1,$2,$3,$4,3) AS ok', [r.params.id, me(r), sid.trim(), hm(process.env.PEPPER, code)])).ok;
      if (!ok) { const e = new Error('NOT_FOUND'); throw e; }
      return { studentId: sid.trim(), claimCode: `${code.slice(0, 5)}-${code.slice(5)}`, validDays: 3 }; })(req, res); });
  app.get('/api/admin/elections/:id/readiness', A, run(async (req) => (await q1('SELECT admin.readiness($1,$2) AS r', [req.params.id, me(req)])).r));
  mountAccounts(app, d, { KEY, requireStaff, run, q1, me, bad, dbErr, cookies });
  return { requireStaff, dbErr };
}
