#!/usr/bin/env node
// Offline election tool: key ceremony (Shamir 3-of-5), standalone chain verifier, tally, results signature check.
// The private key exists only in memory during `keygen` and `tally`; it is never written to disk whole.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import pg from 'pg'; import _s from 'libsodium-wrappers'; import { split, combine } from 'shamir-secret-sharing';
await _s.ready; const S = _s;
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const lp = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
// Must match ballots.entry_hash in SQL byte for byte (shared test vector: server/cli-test.sh).
const entryHash = (prev, chain, id, ct, seq) => sha(Buffer.concat([lp(prev), lp(Buffer.from(chain)), lp(Buffer.from(id)), lp(ct), lp(i64(seq))]));
const args = Object.fromEntries(process.argv.slice(3).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]] : null).filter(Boolean));
const b64 = (u) => Buffer.from(u).toString('base64'); const fromb64 = (s) => new Uint8Array(Buffer.from(s.trim(), 'base64'));
const die = (m) => { console.error('FAIL ' + m); process.exit(1); };

function verifyChain(exp) {
  let prev = sha(Buffer.from(exp.chain)), bad = 0, s = 0;
  for (const r of exp.ballots) { s++; const ct = Buffer.from(r.ciphertext, 'hex'); const h = entryHash(prev, exp.chain, r.id, ct, r.seq).toString('hex');
    if (r.seq !== s || r.prev !== prev.toString('hex') || r.hash !== h) bad++; prev = Buffer.from(r.hash, 'hex'); }
  return bad;
}
const canon = (o) => JSON.stringify(o, Object.keys(o).sort());
const cmd = process.argv[2];
if (cmd === 'keygen') {
  const out = args.out || '.'; fs.mkdirSync(out, { recursive: true });
  const kp = S.crypto_box_keypair(); const sg = S.crypto_sign_keypair();
  const shares = await split(kp.privateKey, 5, 3);
  fs.writeFileSync(path.join(out, 'election.pub'), b64(kp.publicKey));
  fs.writeFileSync(path.join(out, 'signing.pub'), b64(sg.publicKey)); fs.writeFileSync(path.join(out, 'signing.key'), b64(sg.privateKey), { mode: 0o600 });
  shares.forEach((sh, i) => fs.writeFileSync(path.join(out, `share-${i + 1}.txt`), b64(sh), { mode: 0o600 }));
  console.log(`election.pub fingerprint ${sha(kp.publicKey).toString('hex').slice(0, 16)}; 5 shares written, any 3 reconstruct; give each to a different holder, store signing.key separately`);
} else if (cmd === 'verify') {
  const exp = JSON.parse(fs.readFileSync(args.ballots, 'utf8')); const bad = verifyChain(exp);
  if (bad) die(`${bad} broken link(s) in chain ${exp.chain}`); console.log(`OK chain ${exp.chain}: ${exp.ballots.length} ballots intact`);
} else if (cmd === 'tally') {
  const exp = JSON.parse(fs.readFileSync(args.ballots, 'utf8'));
  if (exp.inboxCount !== 0) die('inbox is not empty; seal everything before tallying');
  if (verifyChain(exp)) die('chain verification failed; refusing to tally');
  const shares = args.shares.split(',').map((f) => fromb64(fs.readFileSync(f, 'utf8')));
  if (shares.length < 3) die('need at least 3 shares');
  let sk; try { sk = await combine(shares); } catch { die('shares cannot be combined (duplicates or corrupted)'); } const pk = S.crypto_scalarmult_base(sk);
  const plain = exp.ballots.map((r) => { const m = S.crypto_box_seal_open(new Uint8Array(Buffer.from(r.ciphertext, 'hex')), pk, sk);
    if (!m) die(`ballot ${r.seq} cannot be decrypted (wrong shares?)`); const n = (m[0] << 8) | m[1]; return JSON.parse(Buffer.from(m.slice(2, 2 + n)).toString()); })
    .sort(() => crypto.randomInt(3) - 1);                    // order carries no information
  const counts = {};
  for (const b of plain) for (const s of b.selections) { const c = (counts[s.contestId] ??= { abstain: 0, candidates: {} });
    if (s.abstain) c.abstain++; else for (const id of s.candidateIds) c.candidates[id] = (c.candidates[id] || 0) + 1; }
  const body = JSON.stringify({ chain: exp.chain, ballots: plain.length, chainTip: exp.ballots.at(-1)?.hash ?? null, counts });
  const sig = S.crypto_sign_detached(sha(Buffer.from(body)), fromb64(fs.readFileSync(args.sign, 'utf8')));
  fs.writeFileSync(args.out, JSON.stringify({ body, signature: b64(sig) }, null, 2)); console.log(`OK tallied ${plain.length} ballots -> ${args.out}`);
} else if (cmd === 'verify-results') {
  const r = JSON.parse(fs.readFileSync(args.results, 'utf8'));
  if (!S.crypto_sign_verify_detached(fromb64(r.signature), sha(Buffer.from(r.body)), fromb64(fs.readFileSync(args.pub, 'utf8')))) die('bad results signature'); console.log('OK results signature valid');
} else if (cmd === 'vectors') {
  const v = JSON.parse(fs.readFileSync(args.file, 'utf8')); let prev = sha(Buffer.from(v.chain)), bad = 0;
  for (const e of v.entries) { const h = entryHash(prev, v.chain, e.id, Buffer.from(e.ciphertext, 'hex'), e.seq).toString('hex');
    if (e.prev !== prev.toString('hex') || e.hash !== h) bad++; prev = Buffer.from(e.hash, 'hex'); }
  if (bad) die(`${bad} test vector(s) differ from the JS implementation`); console.log(`OK JS matches ${v.entries.length} chain test vectors`);
} else if (cmd === 'transfer-keygen') {   // central-held transfer key: separate from the election key and never on a lab or drive
  fs.mkdirSync(args.out, { recursive: true }); const kp = S.crypto_box_keypair();
  fs.writeFileSync(path.join(args.out, 'transfer.pub'), b64(kp.publicKey)); fs.writeFileSync(path.join(args.out, 'transfer.key'), b64(kp.privateKey), { mode: 0o600 }); console.log('transfer keypair written');
} else if (cmd === 'pkg-export') {   // cumulative package: every sealed ballot of the lab chain + lab participation, signed by the lab key, sealed to central
  const db = new pg.Client({ connectionString: args.db }); await db.connect(); const E = args.election;
  const ballots = (await db.query("SELECT id, seq::int AS seq, round, encode(ciphertext,'hex') ciphertext, encode(receipt,'hex') receipt, encode(prev_hash,'hex') prev, encode(entry_hash,'hex') hash FROM ballots.ballots WHERE election_id=$1 AND chain_id=$2 ORDER BY seq", [E, args.chain])).rows;
  const participation = (await db.query("SELECT voter_id, round FROM participation.participation WHERE election_id=$1 AND channel='LAB' ORDER BY voter_id", [E])).rows;
  const inboxCount = +(await db.query('SELECT count(*) FROM ballots.inbox WHERE election_id=$1', [E])).rows[0].count; await db.end();
  const payload = Buffer.from(JSON.stringify({ ballots, participation, inboxCount }));
  const manifest = { version: 1, type: args.type || 'FINAL', election_id: E, lab_id: args.lab, ballot_count: ballots.length, participation_count: participation.length, inbox_count: inboxCount,
    chain_tip: ballots.at(-1)?.hash ?? null, payload_sha256: sha(payload).toString('hex'), created_at: new Date().toISOString() };
  const sig = S.crypto_sign_detached(sha(Buffer.from(canon(manifest))), fromb64(fs.readFileSync(args.key, 'utf8')));
  const sealed = S.crypto_box_seal(new Uint8Array(payload), fromb64(fs.readFileSync(args.recipient, 'utf8')));
  fs.writeFileSync(args.out, JSON.stringify({ manifest, signature: b64(sig), payload: b64(sealed) })); console.log(`OK exported ${ballots.length} ballots, ${participation.length} participation rows -> ${args.out}`);
} else if (cmd === 'pkg-import') {   // atomic: everything inside one transaction, or nothing
  const pkg = JSON.parse(fs.readFileSync(args.file, 'utf8')); const m = pkg.manifest; const pool = new pg.Pool({ connectionString: args.db }); const c = await pool.connect();
  const fail = (code) => Object.assign(new Error(code), { code });
  try {
    await c.query('BEGIN');
    if (m.version !== 1) throw fail('WRONG_VERSION');
    const lab = (await c.query('SELECT * FROM sync.labs WHERE id=$1', [m.lab_id])).rows[0]; if (!lab) throw fail('UNKNOWN_LAB'); if (lab.election_id !== m.election_id) throw fail('WRONG_ELECTION');
    if (!S.crypto_sign_verify_detached(fromb64(pkg.signature), sha(Buffer.from(canon(m))), new Uint8Array(lab.public_key))) throw fail('BAD_SIGNATURE');
    const tk = fromb64(fs.readFileSync(args.key, 'utf8')); let pt;
    try { pt = S.crypto_box_seal_open(fromb64(pkg.payload), S.crypto_scalarmult_base(tk), tk); } catch { pt = null; } if (!pt) throw fail('CANNOT_DECRYPT');
    const pid = sha(Buffer.from(pt)); if (pid.toString('hex') !== m.payload_sha256) throw fail('PAYLOAD_MISMATCH');
    if ((await c.query('SELECT 1 FROM sync.imports WHERE package_id=$1', [pid])).rowCount) { await c.query('ROLLBACK'); console.log('NO-OP replayed package already imported'); process.exit(0); }
    const pl = JSON.parse(Buffer.from(pt).toString()); const bs = pl.ballots;
    if (verifyChain({ chain: lab.chain_id, ballots: bs }) || bs.length !== m.ballot_count || (bs.at(-1)?.hash ?? null) !== m.chain_tip) throw fail('CHAIN_INVALID');
    const have = (await c.query('SELECT seq, encode(entry_hash,\'hex\') h FROM ballots.ballots WHERE election_id=$1 AND chain_id=$2 ORDER BY seq', [m.election_id, lab.chain_id])).rows;
    if (have.length > bs.length) throw fail('SUPERSEDED'); if (have.some((r, i) => r.h !== bs[i].hash)) throw fail('PREDECESSOR_MISMATCH');
    for (const p of pl.participation) { const v = (await c.query('SELECT channel FROM election.voters WHERE id=$1 AND election_id=$2', [p.voter_id, m.election_id])).rows[0];
      if (!v || v.channel !== 'LAB') throw fail('UNKNOWN_OR_WRONG_CHANNEL_VOTER');
      if ((await c.query("SELECT 1 FROM participation.participation WHERE election_id=$1 AND round=$2 AND voter_id=$3 AND channel='ONLINE'", [m.election_id, p.round, p.voter_id])).rowCount) throw fail('DUPLICATE_PARTICIPATION');
      await c.query("INSERT INTO participation.participation(election_id, round, voter_id, channel, hour_bucket, request_hash) VALUES ($1,$2,$3,'LAB',date_trunc('hour', now()),$4) ON CONFLICT DO NOTHING", [m.election_id, p.round, p.voter_id, crypto.randomBytes(32)]); }
    if (m.type === 'FINAL' && (pl.inboxCount !== 0 || pl.participation.length !== bs.length)) throw fail('ORPHANS_OR_UNSEALED');
    for (const b of bs.slice(have.length)) await c.query('INSERT INTO ballots.ballots(id, election_id, round, chain_id, seq, receipt, ciphertext, prev_hash, entry_hash) VALUES ($1,$2,$3,$4,$5,decode($6,\'hex\'),decode($7,\'hex\'),decode($8,\'hex\'),decode($9,\'hex\'))', [b.id, m.election_id, b.round, lab.chain_id, b.seq, b.receipt, b.ciphertext, b.prev, b.hash]);
    await c.query('INSERT INTO sync.imports(package_id, election_id, lab_id, pkg_type, ballot_count, chain_tip, report) VALUES ($1,$2,$3,$4,$5,decode($6,\'hex\'),$7)', [pid, m.election_id, m.lab_id, m.type, bs.length, m.chain_tip, { added: bs.length - have.length, participation: pl.participation.length }]);
    await c.query('COMMIT'); console.log(`OK imported ${bs.length - have.length} new ballots (chain ${lab.chain_id} now ${bs.length}), orphans 0`);
  } catch (e) { await c.query('ROLLBACK'); await pool.query('INSERT INTO sync.quarantine(reason, manifest) VALUES ($1,$2)', [e.code || String(e.message), m ?? null]); console.error(`REJECTED ${e.code || e.message} (nothing imported; package quarantined)`); process.exit(1); }
  process.exit(0);
} else if (cmd === 'export-ballots') {   // the tally input for one chain: run on a machine with owner access to the database, never on the web server
  if (!args.db || !args.election || !args.out) die('usage: ev export-ballots --db <url> --election <uuid> --out <file> [--chain main]');
  const db = new pg.Client({ connectionString: args.db }); await db.connect(); const chain = args.chain || 'main';
  const ballots = (await db.query("SELECT id, seq::int AS seq, encode(ciphertext,'hex') ciphertext, encode(prev_hash,'hex') prev, encode(entry_hash,'hex') hash FROM ballots.ballots WHERE election_id=$1 AND chain_id=$2 ORDER BY seq", [args.election, chain])).rows;
  const inboxCount = +(await db.query('SELECT count(*) FROM ballots.inbox WHERE election_id=$1', [args.election])).rows[0].count; await db.end();
  fs.writeFileSync(args.out, JSON.stringify({ chain, inboxCount, ballots })); console.log(`OK exported ${ballots.length} ballots of chain ${chain} (inbox ${inboxCount}) -> ${args.out}`);
} else die('usage: ev keygen|verify|tally|verify-results|export-ballots|...');
