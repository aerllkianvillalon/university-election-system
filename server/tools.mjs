// Dev/test helpers: hash <pw> | enc <hexsecret> (needs STAFF_KEY) | code <hexsecret> | sign <signing.key file> <body file>  (signs sha256(body) like `ev tally`; for forged-file tests)
import { hash } from '@node-rs/argon2'; import { seal, totp, step } from './totp.mjs';
const [cmd, a, b2] = process.argv.slice(2);
if (cmd === 'hash') console.log(await hash(a)); else if (cmd === 'enc') console.log(seal(Buffer.from(process.env.STAFF_KEY, 'hex'), Buffer.from(a, 'hex')).toString('hex')); else if (cmd === 'code') console.log(totp(Buffer.from(a, 'hex'), step()));

if (cmd === 'sign') { const { default: S } = await import('libsodium-wrappers'); await S.ready; const fs = await import('node:fs'); const { createHash } = await import('node:crypto');
  const sk = new Uint8Array(Buffer.from(fs.readFileSync(a, 'utf8').trim(), 'base64')); console.log(Buffer.from(S.crypto_sign_detached(createHash('sha256').update(fs.readFileSync(b2)).digest(), sk)).toString('base64')); }
