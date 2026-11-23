// Lab HTTP: proctor station (staff + MFA) and booth kiosk (identified by TLS client-certificate fingerprint forwarded by the local Caddy, never by anything the page sends).
import { seal, open } from './totp.mjs';
export function mountLab(app, d, staff) {
  const { pool, sha, str, crypto, sodium, contestsFor, validSelections, ELECTION_PUBKEY } = d; const { requireStaff, dbErr } = staff;
  const LK = Buffer.from(process.env.LAB_SESSION_KEY || '', 'hex'); if (LK.length !== 32) throw new Error('LAB_SESSION_KEY must be 64 hex characters');
  const P = requireStaff('PROCTOR'), reject = (res, reason) => res.status(409).json({ error: { code: reason, message: 'Not allowed.' } });
  const sameOrg = async (e, staffId) => (await pool.query('SELECT admin.same_org($1,$2) AS ok', [e, staffId])).rows[0].ok;
  app.post('/api/lab/checkin', P, async (req, res) => { const { electionId, studentId } = req.body || {}; if (!str(electionId, 36) || !str(studentId, 32)) return reject(res, 'VALIDATION_FAILED');
    if (!(await sameOrg(electionId, req.staff.staff_id))) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not allowed.' } });
    const r = (await pool.query('SELECT lab.check_in($1,$2) AS r', [electionId, studentId])).rows[0].r; if (!r.ok) return reject(res, r.reason);
    const v = (await pool.query('SELECT attrs FROM election.voters WHERE id=$1', [r.voter_id])).rows[0]; res.json({ ok: true, voterId: r.voter_id, attributes: v.attrs }); });
  app.post('/api/lab/issue', P, async (req, res) => { const { electionId, voterId, boothId } = req.body || {};
    try { if (!(await sameOrg(electionId, req.staff.staff_id))) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not allowed.' } });
      const token = crypto.randomBytes(32).toString('base64url');   // the proctor never sees this token; the booth receives it on its next poll
      const r = (await pool.query('SELECT lab.issue_session($1,$2,$3,$4) AS r', [electionId, voterId, boothId, sha(token)])).rows[0].r; if (!r.ok) return reject(res, r.reason);
      await pool.query('SELECT lab.attach_token($1,$2)', [r.session_id, seal(LK, Buffer.from(token))]); res.json({ ok: true, sessionId: r.session_id, expiresAt: r.expires_at }); } catch (e) { dbErr(res, e); } });
  app.post('/api/lab/cancel', P, async (req, res) => { const { sessionId, reason } = req.body || {}; if (!str(reason, 200)) return reject(res, 'VALIDATION_FAILED');
    const e = (await pool.query('SELECT lab.session_election($1) AS e', [sessionId])).rows[0].e; if (!e || !(await sameOrg(e, req.staff.staff_id))) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not allowed.' } });
    res.json({ ok: (await pool.query('SELECT lab.cancel_session($1,$2) AS ok', [sessionId, reason])).rows[0].ok }); });
  app.get('/api/lab/board', P, async (req, res) => { try { res.json((await pool.query('SELECT lab.board($1,$2) AS b', [String(req.query.electionId), req.staff.staff_id])).rows[0].b); } catch (e) { dbErr(res, e); } });

  const booth = async (req, res, next) => { const fp = process.env.TRUST_CERT_HEADER === '1' ? req.get('x-client-cert-fingerprint') : null;
    const id = fp && (await pool.query('SELECT lab.booth_for_cert($1) AS id', [fp])).rows[0].id;
    if (!id) return res.status(401).json({ error: { code: 'BOOTH_NOT_REGISTERED', message: 'This machine is not registered as a booth.' } }); req.booth = id; next(); };
  app.get('/api/lab/booth/poll', booth, async (req, res) => { const enc = (await pool.query('SELECT lab.pending_token($1) AS t', [req.booth])).rows[0].t;
    res.json(enc ? { state: 'ASSIGNED', sessionToken: open(LK, enc).toString() } : { state: 'IDLE' }); });
  app.post('/api/lab/booth/start', booth, async (req, res) => { const tok = req.body?.sessionToken; if (!str(tok, 64)) return reject(res, 'INVALID_SESSION');
    const r = (await pool.query('SELECT lab.start_session($1,$2) AS r', [sha(tok), req.booth])).rows[0].r; if (!r.ok) return reject(res, r.reason);
    res.json({ ok: true, round: 1, expiresAt: r.expires_at, contests: await contestsFor(r.election_id, r.voter_id) }); });
  app.post('/api/lab/booth/cast', booth, async (req, res) => { const { sessionToken, selections } = req.body || {}; if (!str(sessionToken, 64)) return reject(res, 'INVALID_SESSION');
    const th = sha(sessionToken), info = (await pool.query('SELECT * FROM lab.session_info($1,$2)', [th, req.booth])).rows[0];
    if (!info) return reject(res, (await pool.query("SELECT lab.cast_ballot($1,$2,1,'\\\\x00','\\\\x00') AS r", [th, req.booth])).rows[0].r);   // returns the precise rejection; nothing is ever inserted on this path
    if (!validSelections(await contestsFor(info.election_id, info.voter_id), selections)) return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Invalid ballot.' } });
    const pt = Buffer.from(JSON.stringify({ round: 1, selections })), padded = Buffer.alloc(2048); if (pt.length > 1800) return reject(res, 'VALIDATION_FAILED'); padded.writeUInt16BE(pt.length); pt.copy(padded, 2);
    const ct = Buffer.from(sodium.crypto_box_seal(padded, Buffer.from(ELECTION_PUBKEY, 'base64'))), receipt = crypto.randomBytes(32);
    const out = (await pool.query('SELECT lab.cast_ballot($1,$2,1,$3,$4) AS r', [th, req.booth, receipt, ct])).rows[0].r;
    if (out !== 'RECORDED') return reject(res, out); await pool.query('SELECT lab.clear_token($1)', [info.session_id]); res.json({ receipt: receipt.toString('hex') }); });
}
