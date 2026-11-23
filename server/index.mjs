// Core API: CSRF, register, login, vote. Fails closed where the spec is not yet implemented (ballot scope).
import express from 'express'; import pg from 'pg'; import crypto from 'node:crypto'; import sodium from 'libsodium-wrappers';
import { hash, verify } from '@node-rs/argon2';
await sodium.ready;
const { DATABASE_URL, PEPPER, REQUEST_KEY, RECEIPT_KEY, ELECTION_PUBKEY, PORT = 3001 } = process.env;
for (const [k, v] of Object.entries({ DATABASE_URL, PEPPER, REQUEST_KEY, RECEIPT_KEY, ELECTION_PUBKEY })) if (!v) throw new Error(`${k} is required`);
const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
const hm = (k, v) => crypto.createHmac('sha256', k).update(v).digest();
const sha = (v) => crypto.createHash('sha256').update(v).digest();
const cookies = (r) => Object.fromEntries((r.headers.cookie || '').split('; ').filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)]; }));
const setCookie = (res, n, v, age) => res.append('Set-Cookie', `${n}=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`);
const sleepTo = (t0, ms) => new Promise((r) => setTimeout(r, Math.max(0, ms - (Date.now() - t0))));
const str = (v, max = 128) => typeof v === 'string' && v.length > 0 && v.length <= max;
const FAIL = { error: { code: 'REQUEST_FAILED', message: 'We couldn’t complete that request. Check your details and try again.' } };
const allow = async (k, l, s) => (await pool.query('SELECT security.hit($1,$2,$3) AS ok', [k, l, s])).rows[0].ok;
const tooMany = (res) => res.status(429).set('Retry-After', '60').json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a minute.' } });
const DUMMY = await hash('timing-equalizer-password');
const app = express(); app.disable('x-powered-by');
// Behind a reverse proxy every request would otherwise appear to come from the proxy, and all IP rate limits would be shared. TRUST_PROXY = number of proxy hops (e.g. 1).
if (process.env.TRUST_PROXY) { const h = Number(process.env.TRUST_PROXY); if (!Number.isInteger(h) || h < 1 || h > 5) throw new Error('TRUST_PROXY must be a whole number of proxy hops from 1 to 5'); app.set('trust proxy', h); }
for (const m of ['get', 'post', 'put', 'delete']) { const orig = app[m].bind(app);   // Express 4 lets one rejected promise kill the process; this turns it into a 500 for every route, staff and lab routes included
  app[m] = (path, ...handlers) => handlers.length === 0 ? orig(path) : orig(path, ...handlers.map((fn) => (typeof fn === 'function' && fn.length < 4 ? (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next) : fn))); } app.use('/api/admin/elections/:id/roll', express.json({ limit: '2mb' })); app.use('/api/admin/elections/:id/results', express.json({ limit: '1mb' }));   // a signed tally for a large election exceeds the 32 KB default   // roll uploads are larger than other bodies
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); next(); });
app.get('/api/csrf', (req, res) => { const token = crypto.randomBytes(24).toString('base64url'); setCookie(res, 'csrf', token, 3600); res.json({ token }); });
app.use((req, res, next) => { // CSRF double-submit on every write
  if (req.method === 'GET') return next();
  const a = Buffer.from(String(req.get('x-csrf-token') || '')), b = Buffer.from(cookies(req).csrf || '');
  if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid request.' } });
  next(); });

app.post('/api/auth/register', async (req, res) => {
  const t0 = Date.now(), b = req.body || {}; let ok = false;
  if (!(await allow(`reg:ip:${req.ip}`, 20, 3600)) || !(await allow(`reg:${b.electionId}:${b.studentId}`, 10, 3600))) return tooMany(res);
  try {
    if (str(b.electionId, 36) && str(b.studentId, 32) && str(b.voucher, 64) && str(b.password) && b.password.length >= 8 && b.termsAccepted === true) {
      const ph = await hash(b.password);
      ok = !!(await pool.query('SELECT identity.register($1,$2,$3,$4) AS id', [b.electionId, b.studentId, hm(PEPPER, b.voucher), ph])).rows[0].id;
    }
  } catch (e) { ok = false; if (process.env.DEBUG_API) console.error(e); }
  await sleepTo(t0, 500); res.status(ok ? 200 : 400).json(ok ? { ok: true } : FAIL);
});

app.post('/api/auth/login', async (req, res) => {
  const t0 = Date.now(), b = req.body || {}; let sid = null;
  if (!(await allow(`login:ip:${req.ip}`, 60, 60)) || !(await allow(`login:${b.electionId}:${b.studentId}`, 5, 900))) return tooMany(res);
  try {
    if (str(b.electionId, 36) && str(b.studentId, 32) && str(b.password)) {
      const row = (await pool.query('SELECT v.id, a.password_hash FROM election.voters v JOIN identity.accounts a ON a.voter_id = v.id WHERE v.election_id=$1 AND v.student_id=$2', [b.electionId, b.studentId])).rows[0];
      const good = await verify(row ? row.password_hash : DUMMY, b.password).catch(() => false);
      if (row && good) {
        sid = crypto.randomBytes(32).toString('base64url');
        await pool.query("INSERT INTO identity.sessions VALUES ($1,$2,$3, now() + interval '30 minutes')", [sha(sid), row.id, b.electionId]);
      }
    }
  } catch (e) { sid = null; if (process.env.DEBUG_API) console.error(e); }
  await sleepTo(t0, 500);
  if (!sid) return res.status(401).json(FAIL);
  setCookie(res, 'sid', sid, 1800); res.json({ ok: true });
});

app.post('/api/auth/logout', async (req, res) => { const sid = cookies(req).sid;
  if (sid) await pool.query('DELETE FROM identity.sessions WHERE id_hash=$1', [sha(sid)]); setCookie(res, 'sid', '', 0); res.json({ ok: true }); });
// Forgot password: always 202, same timing. The link goes ONLY to the registrar's roll email (queued in ops.outbox for the mail adapter).
app.post('/api/auth/forgot', async (req, res) => {
  const t0 = Date.now(), b = req.body || {};
  if (!(await allow(`forgot:ip:${req.ip}`, 20, 3600)) || !(await allow(`forgot:${b.electionId}:${b.studentId}`, 3, 3600))) return tooMany(res);
  try { if (str(b.electionId, 36) && str(b.studentId, 32)) { const token = crypto.randomBytes(32).toString('base64url');
    await pool.query('SELECT identity.start_reset($1,$2,$3,$4)', [b.electionId, b.studentId, sha(token), `Open ${process.env.PUBLIC_URL || ''}/reset-password?token=${token} within 15 minutes. If you did not ask for this, ignore it.`]); }
  } catch (e) { if (process.env.DEBUG_API) console.error(e); }
  await sleepTo(t0, 500); res.status(202).json({ ok: true });
});
// GET only reports validity and never consumes the token (email scanners pre-fetch links).
app.get('/api/auth/reset/:token', async (req, res) => {
  const r = await pool.query('SELECT 1 FROM identity.reset_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()', [sha(String(req.params.token))]);
  res.json({ valid: r.rowCount > 0 });
});
app.post('/api/auth/reset', async (req, res) => {
  const t0 = Date.now(), b = req.body || {}; let ok = false;
  if (!(await allow(`reset:ip:${req.ip}`, 20, 3600))) return tooMany(res);
  try { if (str(b.token, 64) && str(b.newPassword) && b.newPassword.length >= 8) ok = (await pool.query('SELECT identity.redeem_reset($1,$2) AS ok', [sha(b.token), await hash(b.newPassword)])).rows[0].ok; } catch { ok = false; }
  await sleepTo(t0, 500); res.status(ok ? 200 : 400).json(ok ? { ok: true } : { error: { code: 'RESET_LINK_EXPIRED', message: 'This link is no longer valid. Request a new one.' } });
});
const session = async (req) => { const sid = cookies(req).sid;
  return sid ? (await pool.query('SELECT voter_id, election_id FROM identity.sessions WHERE id_hash=$1 AND expires_at > now()', [sha(sid)])).rows[0] : undefined; };
// Contests come ONLY from the database, computed from the voter's roll attributes. The client never sends attributes.
async function contestsFor(electionId, voterId) {
  const ps = (await pool.query('SELECT * FROM election.voter_contests($1,$2)', [electionId, voterId])).rows;
  const cs = (await pool.query('SELECT id, position_id, name, platform FROM election.candidates WHERE position_id = ANY($1) AND withdrawn_at IS NULL ORDER BY name', [ps.map((p) => p.id)])).rows;
  return ps.map((p) => ({ id: p.id, positionTitle: p.title, seatCount: p.seats, minSelections: p.min_sel, maxSelections: p.seats, allowAbstain: p.allow_abstain,
    candidates: cs.filter((c) => c.position_id === p.id).map((c) => ({ id: c.id, name: c.name, platformSummary: c.platform })) }));
}
function validSelections(contests, sel) {
  if (!Array.isArray(sel) || sel.length !== contests.length) return false;
  const seen = new Set();
  return sel.every((s) => {
    const c = contests.find((x) => x.id === s?.contestId); if (!c || seen.has(c.id) || !Array.isArray(s.candidateIds) || typeof s.abstain !== 'boolean') return false;
    seen.add(c.id); const ids = s.candidateIds;
    if (new Set(ids).size !== ids.length || !ids.every((i) => c.candidates.some((k) => k.id === i))) return false;
    if (s.abstain) return c.allowAbstain && ids.length === 0;
    return ids.length >= Math.max(1, c.minSelections) && ids.length <= c.maxSelections;
  });
}
app.get('/api/elections/:id/ballot', async (req, res) => {
  const s = await session(req); if (!s || s.election_id !== req.params.id) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to vote.' } });
  res.json({ round: 1, ballotSeed: hm(PEPPER, `seed:${s.voter_id}`).toString('hex').slice(0, 16), contests: await contestsFor(s.election_id, s.voter_id) });
});
app.post('/api/elections/:id/ballot', async (req, res) => {
  const s = await session(req); if (!s || s.election_id !== req.params.id) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to vote.' } });
  const { nonce, round, selections } = req.body || {}; const bad = () => res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Invalid ballot.' } });
  if (!/^[0-9a-f-]{36}$/i.test(String(nonce)) || ![1, 2].includes(round)) return bad();
  if (!validSelections(await contestsFor(s.election_id, s.voter_id), selections)) return bad();
  const pt = Buffer.from(JSON.stringify({ round, selections })); if (pt.length > 1800) return bad();
  const padded = Buffer.alloc(2048); padded.writeUInt16BE(pt.length); pt.copy(padded, 2); // fixed-length plaintext
  const ct = Buffer.from(sodium.crypto_box_seal(padded, Buffer.from(ELECTION_PUBKEY, 'base64')));
  const receipt = hm(RECEIPT_KEY, `${nonce}:${s.voter_id}`);
  const out = (await pool.query('SELECT ballots.cast_ballot($1,$2,$3,$4,$5,$6) AS r', [s.election_id, round, s.voter_id, hm(REQUEST_KEY, `${nonce}:${s.voter_id}`), receipt, ct])).rows[0].r;
  if (out === 'RECORDED' || out === 'DUPLICATE_RETRY') return res.json({ receipt: receipt.toString('hex') });
  res.status(409).json({ error: { code: out, message: 'Your vote could not be recorded.' } });
});
const isUuid = (v) => /^[0-9a-f-]{36}$/i.test(String(v)), NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'Not found.' } };
app.get('/api/me', async (req, res) => { const s = await session(req); if (!s) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
  res.json({ electionId: s.election_id, hasVoted: (await pool.query('SELECT election.has_voted($1,$2,1) AS v', [s.election_id, s.voter_id])).rows[0].v }); });
app.get('/api/elections/:id/info', async (req, res) => { if (!isUuid(req.params.id)) return res.status(404).json(NOT_FOUND); if (!(await allow(`info:ip:${req.ip}`, 120, 60))) return tooMany(res);
  const i = (await pool.query('SELECT election.public_info($1) AS i', [req.params.id])).rows[0].i; i ? res.json(i) : res.status(404).json(NOT_FOUND); });
app.get('/api/elections/:id/results', async (req, res) => {   // public; nothing but the status until the election is certified
  if (!isUuid(req.params.id)) return res.status(404).json(NOT_FOUND); if (!(await allow(`res:ip:${req.ip}`, 60, 60))) return tooMany(res);
  const r = (await pool.query('SELECT election.public_results($1) AS r', [req.params.id])).rows[0].r; if (!r) return res.status(404).json(NOT_FOUND);
  if (r.published) res.set('Cache-Control', 'public, max-age=60'); res.json(r); });
app.get('/api/elections/:id/receipt/:hash', async (req, res) => { if (!isUuid(req.params.id) || !/^[0-9a-f]{64}$/.test(req.params.hash)) return res.status(404).json(NOT_FOUND); if (!(await allow(`rcpt:ip:${req.ip}`, 60, 60))) return tooMany(res);
  const st = (await pool.query('SELECT ballots.receipt_status($1,$2) AS s', [req.params.id, Buffer.from(req.params.hash, 'hex')])).rows[0].s; res.json({ recorded: !!st, sealed: st === 'sealed' }); });
// ---- Support forms. These only RECORD; nothing here changes an account except redeeming a staff-issued claim code. ----
const REF_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O/1/I: a reference is read aloud and copied by hand
const newRef = () => { const b = crypto.randomBytes(8); const c = [...b].map((x) => REF_CHARS[x % REF_CHARS.length]).join(''); return `${c.slice(0, 4)}-${c.slice(4)}`; };
const normCode = (v) => String(v).replace(/[\s-]/g, '').toUpperCase();
const safe = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); if (!res.headersSent) res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong.' } }); });
const BAD_FORM = { error: { code: 'VALIDATION_FAILED', message: 'Check the form and try again.' } };
app.post('/api/support/claim', safe(async (req, res) => {   // in-person claim: Student ID + staff-issued one-time code + new password
  const t0 = Date.now(), b = req.body || {}; let ok = false;
  if (!(await allow(`claim:ip:${req.ip}`, 20, 3600))) return tooMany(res);
  if (str(b.electionId, 36) && str(b.studentId, 32) && !(await allow(`claim:${b.electionId.toLowerCase()}:${b.studentId.trim()}`, 5, 3600))) return tooMany(res);   // the code is only 40 bits, so attempts per student are what protect it
  try { if (isUuid(b.electionId) && str(b.studentId, 32) && str(b.claimCode, 32) && str(b.password) && b.password.length >= 8)
    ok = (await pool.query('SELECT identity.redeem_claim($1,$2,$3,$4) AS ok', [b.electionId, b.studentId.trim(), hm(PEPPER, normCode(b.claimCode)), await hash(b.password)])).rows[0].ok; } catch (e) { if (process.env.DEBUG_API) console.error(e); }
  await sleepTo(t0, 500); res.status(ok ? 200 : 400).json(ok ? { ok: true } : FAIL);   // one answer for wrong code, wrong student, expired, used
}));
const SUPPORT_RULES = { protest: { student: true, subject: true, details: true }, dispute: { student: true, details: true }, report: { url: true } };
app.post('/api/support/:kind', safe(async (req, res) => {
  const rule = SUPPORT_RULES[req.params.kind]; if (!rule) return res.status(404).json(NOT_FOUND);
  if (!(await allow(`support:ip:${req.ip}`, 10, 3600))) return tooMany(res);
  const b = req.body || {}, opt = (v, max) => v == null || v === '' || (typeof v === 'string' && v.length <= max);
  const ok = isUuid(b.electionId) && (!rule.student || str(typeof b.studentId === 'string' ? b.studentId.trim() : '', 32)) && (!rule.subject || str(b.subject, 200)) && (!rule.details || str(b.details, 4000)) && (!rule.url || str(b.url, 2000))
    && opt(b.details, 4000) && opt(b.subject, 200) && opt(b.url, 2000) && opt(b.studentId, 32);
  if (!ok) return res.status(400).json(BAD_FORM);
  if (rule.student && !(await allow(`support:${req.params.kind}:${b.electionId}:${b.studentId.trim()}`, 5, 86400))) return tooMany(res);   // 5 a day per Student ID, so one filer cannot bury the queue
  const sess = await session(req);
  for (let i = 0; i < 3; i++) { const ref = newRef();
    const r = (await pool.query('SELECT support.file($1,$2,$3,$4,$5,$6,$7,$8) AS r', [b.electionId, req.params.kind, rule.student ? b.studentId.trim() : null, b.subject || null, b.details || '', b.url || null, ref, sess?.voter_id ?? null])).rows[0].r;
    if (r === 'ok') return res.status(202).json({ ok: true, reference: ref });
    if (r === 'NO_ELECTION') return res.status(400).json(BAD_FORM); }   // otherwise a reference collision, so retry with a new one
  res.status(503).json({ error: { code: 'TRY_AGAIN', message: 'Please try again.' } });
}));
if (process.env.STAFF_KEY) { // staff, admin and lab HTTP are enabled only when their keys are configured
  // In-lab voting is a later phase. It is OFF unless LAB_ENABLED=1 (and LAB_SESSION_KEY is set); everything it needs stays in the database and in server/lab.mjs.
  const deps = { LAB_ENABLED: process.env.LAB_ENABLED === '1', pool, sha, hm, cookies, setCookie, str, allow, tooMany, verify, DUMMY, crypto, sleepTo, FAIL, sodium, contestsFor, validSelections, ELECTION_PUBKEY };
  const staff = (await import('./staff.mjs')).mountStaff(app, deps); if (process.env.LAB_ENABLED === '1' && process.env.LAB_SESSION_KEY) (await import('./lab.mjs')).mountLab(app, deps, staff);
}
app.use((err, req, res, next) => {   // never leak internals; a malformed JSON body is the client's fault, anything else is ours
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Invalid request.' } });
  console.error(err); res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong.' } }); });
app.listen(PORT, '127.0.0.1', () => console.log(`api on ${PORT}`));
