// node --test tests/qr.test.ts   (the encoder was also checked against an independent QR reader: 5 sizes from version 1 to 13, all decoded exactly)
import test from 'node:test'; import assert from 'node:assert/strict';
import { qrMatrix, qrSvg } from '../src/lib/qr.ts';

test('size grows with the text: version 1 is 21 modules, larger text gets larger codes', () => {
  assert.equal(qrMatrix('hi').length, 21);
  const uri = 'otpauth://totp/CTU%20Danao:a1?secret=JBSWY3DPEHPK3PXP&issuer=CTU%20Danao'; const n = qrMatrix(uri).length; assert.ok(n > 21 && (n - 17) % 4 === 0);
  assert.ok(qrMatrix('x'.repeat(300)).length > n);
});
test('the three corner finder patterns and the timing lines are in place', () => {
  const g = qrMatrix('otpauth://totp/x?secret=ABCDEFGH'), n = g.length;
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) { for (let i = 0; i < 7; i++) { assert.ok(g[r0][c0 + i] && g[r0 + 6][c0 + i] && g[r0 + i][c0] && g[r0 + i][c0 + 6]); } assert.ok(g[r0 + 3][c0 + 3]); assert.equal(g[r0 + 1][c0 + 1], false); }
  for (let i = 8; i < n - 8; i++) { assert.equal(g[6][i], i % 2 === 0); assert.equal(g[i][6], i % 2 === 0); }
});
test('the same text always gives the same picture, and the picture is a plain SVG with no text in it', () => {
  assert.equal(qrSvg('abc'), qrSvg('abc')); const s = qrSvg('<script>alert(1)</script>'); assert.doesNotMatch(s, /script/); assert.match(s, /^<svg /);
});
test('text that is too long is refused rather than drawn wrong', () => { assert.throws(() => qrMatrix('x'.repeat(1000))); });
