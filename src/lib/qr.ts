// Small QR code encoder (byte mode, error correction level M, versions 1 to 14). Used only to draw the authenticator setup code.
// Based on the standard QR algorithm: Reed-Solomon over GF(256), 8 mask patterns scored by the standard penalty rules.
const EXP = new Array<number>(512), LOG = new Array<number>(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
function rsGenerator(deg: number): number[] { let g = [1]; for (let i = 0; i < deg; i++) { const n = new Array<number>(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { n[j] ^= g[j]; n[j + 1] ^= mul(g[j], EXP[i]); } g = n; } return g; }
function rsRemainder(data: number[], deg: number): number[] { const g = rsGenerator(deg), r = new Array<number>(deg).fill(0); for (const b of data) { const f = b ^ r.shift()!; r.push(0); if (f) for (let i = 0; i < deg; i++) r[i] ^= mul(g[i + 1], f); } return r; }

// [total codewords, ec codewords per block, blocks in group 1, data per block in group 1, blocks in group 2, data per block in group 2] for level M
const M_TABLE: Record<number, [number, number, number, number, number, number]> = {
  1: [26, 10, 1, 16, 0, 0], 2: [44, 16, 1, 28, 0, 0], 3: [70, 26, 1, 44, 0, 0], 4: [100, 18, 2, 32, 0, 0], 5: [134, 24, 2, 43, 0, 0], 6: [172, 16, 4, 27, 0, 0], 7: [196, 18, 4, 31, 0, 0],
  8: [242, 22, 2, 38, 2, 39], 9: [292, 22, 3, 36, 2, 37], 10: [346, 26, 4, 43, 1, 44], 11: [404, 30, 1, 50, 4, 51], 12: [466, 22, 6, 36, 2, 37], 13: [532, 22, 8, 37, 1, 38], 14: [581, 24, 4, 40, 5, 41],
};
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66] };

function bch(value: number, poly: number, polyBits: number): number { let v = value << (polyBits - 1); const top = (x: number) => 31 - Math.clz32(x); while (top(v) >= polyBits - 1) v ^= poly << (top(v) - (polyBits - 1)); return v; }
const formatBits = (mask: number) => ((((0b00 << 3) | mask) << 10) | bch(((0b00 << 3) | mask), 0x537, 11)) ^ 0x5412;   // level M = 00
const versionBits = (ver: number) => (ver << 12) | bch(ver, 0x1f25, 13);

export function qrMatrix(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 1; for (; ver <= 14; ver++) { const t = M_TABLE[ver]; const cap = t[2] * t[3] + t[4] * t[5]; const need = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8; if (need <= cap * 8) break; }
  if (ver > 14) throw new Error('Text too long for this QR code');
  const [total, ecPer, g1n, g1d, g2n, g2d] = M_TABLE[ver]; const dataCap = g1n * g1d + g2n * g2d;
  const bits: number[] = []; const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  put(0b0100, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, dataCap * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const data: number[] = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < dataCap; pad ^= 0xec ^ 0x11) data.push(pad);
  const blocks: number[][] = []; let at = 0; for (let b = 0; b < g1n + g2n; b++) { const n = b < g1n ? g1d : g2d; blocks.push(data.slice(at, at + n)); at += n; }
  const ecs = blocks.map((b) => rsRemainder(b, ecPer)); const out: number[] = [];
  for (let i = 0; i < Math.max(g1d, g2d); i++) blocks.forEach((b) => { if (i < b.length) out.push(b[i]); });
  for (let i = 0; i < ecPer; i++) ecs.forEach((e) => out.push(e[i]));
  if (out.length !== total) throw new Error('QR table error');

  const size = 17 + 4 * ver, m: (boolean | null)[][] = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null)), fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (r: number, c: number, v: boolean) => { m[r][c] = v; fixed[r][c] = true; };
  const finder = (r0: number, c0: number) => { for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) { const rr = r0 + r, cc = c0 + c; if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue; set(rr, cc, r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))); } };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const al = ALIGN[ver]; for (const r of al) for (const c of al) { if ((r === 6 && c === 6) || (r === 6 && c === al[al.length - 1]) || (r === al[al.length - 1] && c === 6)) continue; for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1); }
  set(size - 8, 8, true);
  for (let i = 0; i < 9; i++) { if (!fixed[8][i]) set(8, i, false); if (!fixed[i][8]) set(i, 8, false); } for (let i = 0; i < 8; i++) { if (!fixed[8][size - 1 - i]) set(8, size - 1 - i, false); if (!fixed[size - 1 - i][8]) set(size - 1 - i, 8, false); }
  if (ver >= 7) { const vb = versionBits(ver); for (let i = 0; i < 18; i++) { const v = ((vb >> i) & 1) === 1, a = Math.floor(i / 3), b = (i % 3) + size - 11; set(a, b, v); set(b, a, v); } }

  const stream: number[] = []; out.forEach((b) => put2(stream, b)); function put2(a: number[], v: number) { for (let i = 7; i >= 0; i--) a.push((v >> i) & 1); }
  const place = (mask: number): boolean[][] => {
    const g = m.map((row) => row.map((v) => v === true)); let k = 0, up = true;
    for (let c = size - 1; c > 0; c -= 2) { if (c === 6) c--; for (let i = 0; i < size; i++) { const r = up ? size - 1 - i : i; for (let d = 0; d < 2; d++) { const cc = c - d; if (fixed[r][cc]) continue; let v = k < stream.length ? stream[k] === 1 : false; k++; const mk = [(r + cc) % 2 === 0, r % 2 === 0, cc % 3 === 0, (r + cc) % 3 === 0, (Math.floor(r / 2) + Math.floor(cc / 3)) % 2 === 0, ((r * cc) % 2) + ((r * cc) % 3) === 0, (((r * cc) % 2) + ((r * cc) % 3)) % 2 === 0, (((r + cc) % 2) + ((r * cc) % 3)) % 2 === 0][mask]; g[r][cc] = v !== mk; } } up = !up; }
    const f = formatBits(mask); for (let i = 0; i < 15; i++) { const v = ((f >> i) & 1) === 1; if (i < 6) g[i][8] = v; else if (i < 8) g[i + 1][8] = v; else g[size - 15 + i][8] = v; if (i < 8) g[8][size - 1 - i] = v; else if (i < 9) g[8][15 - i] = v; else g[8][14 - i] = v; }
    g[size - 8][8] = true; return g;
  };
  const penalty = (g: boolean[][]): number => {
    let p = 0; const n = size;
    const line = (get: (i: number) => boolean) => { let run = 1; for (let i = 1; i < n; i++) { if (get(i) === get(i - 1)) { run++; if (i === n - 1 && run >= 5) p += run - 2; } else { if (run >= 5) p += run - 2; run = 1; } } };
    for (let r = 0; r < n; r++) { line((i) => g[r][i]); line((i) => g[i][r]); }
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (g[r][c] === g[r][c + 1] && g[r][c] === g[r + 1][c] && g[r][c] === g[r + 1][c + 1]) p += 3;
    const pat = [true, false, true, true, true, false, true, false, false, false, false], rev = [...pat].reverse();
    for (let r = 0; r < n; r++) for (let c = 0; c <= n - 11; c++) { if (pat.every((v, i) => g[r][c + i] === v) || rev.every((v, i) => g[r][c + i] === v)) p += 40; if (pat.every((v, i) => g[c + i][r] === v) || rev.every((v, i) => g[c + i][r] === v)) p += 40; }
    let dark = 0; for (const row of g) for (const v of row) if (v) dark++; p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10; return p;
  };
  let best = place(0), bp = penalty(best); for (let k = 1; k < 8; k++) { const g = place(k), s = penalty(g); if (s < bp) { bp = s; best = g; } }
  return best;
}

export function qrSvg(text: string, quiet = 4): string {
  const g = qrMatrix(text), n = g.length + quiet * 2; let d = '';
  g.forEach((row, r) => { let c = 0; while (c < row.length) { if (!row[c]) { c++; continue; } let e = c; while (e < row.length && row[e]) e++; d += `M${c + quiet} ${r + quiet}h${e - c}v1h-${e - c}z`; c = e; } });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code for your authenticator app"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
