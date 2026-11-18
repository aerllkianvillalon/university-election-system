import crypto from 'node:crypto';
export const step = (ms = Date.now()) => Math.floor(ms / 30000);
export function totp(secret, st) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(st)); const h = crypto.createHmac('sha1', secret).update(b).digest(); const o = h[19] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0'); }
export const seal = (key, buf) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); const ct = Buffer.concat([c.update(buf), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]); };
export const open = (key, b) => { const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]); };
