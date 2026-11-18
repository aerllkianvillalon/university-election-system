// DEV/TEST ONLY: decrypts the inbox of a local test election with the dev private key from /tmp/live.env and prints JSON.
// A real election's private key is never on the same machine as the database (see the key ceremony); this tool cannot work there.
import sodium from 'libsodium-wrappers'; import { execFileSync } from 'node:child_process'; await sodium.ready;
const { LIVE_DB = 'evlive', ELECTION_ID, ELECTION_PUBKEY, ELECTION_SECRET } = process.env;
const pk = Buffer.from(ELECTION_PUBKEY, 'base64'), sk = Buffer.from(ELECTION_SECRET, 'base64');
const rows = execFileSync('psql', ['-X', '-tA', LIVE_DB, '-c', `SELECT encode(ciphertext,'hex') FROM ballots.inbox WHERE election_id='${ELECTION_ID}'`]).toString().split('\n').filter(Boolean);
console.log(JSON.stringify(rows.map((h) => { const p = Buffer.from(sodium.crypto_box_seal_open(Buffer.from(h, 'hex'), pk, sk)); return JSON.parse(p.subarray(2, 2 + p.readUInt16BE(0)).toString()); })));
