import type { ResultsProof, Lifecycle, ElectionStatus, Organization, ApiResult, AuthRequest, BallotDraft, CertifiedResult, Election, OrganizationElection, Receipt, RegisterRequest, SelectionMap, SupportKind } from './types';
import { GENERIC_FAILURE_MESSAGE } from './types';

const DRAFT_KEY = 'ctu.ballot.v1';
const DRAFT_TTL = 10 * 60 * 1000;
const SUPPORT_DONE = 'Thank you. If your details match a record, the Electoral Committee will follow up through official channels.';
let memoryDraft: BallotDraft = { electionId: 'election-current', selections: {}, expiresAt: Date.now() + DRAFT_TTL };
let lastProof: ResultsProof | null = null;   // what the public results endpoint last returned, for the "check it yourself" section
const RECEIPT_KEY = 'ctuvote:receipt';
let lastReceipt: Receipt | null = null;
function keepReceipt(r: Receipt | null): Receipt | null { lastReceipt = r; if (hasSession()) { try { if (r) sessionStorage.setItem(RECEIPT_KEY, JSON.stringify(r)); else sessionStorage.removeItem(RECEIPT_KEY); } catch { /* storage unavailable: the receipt stays in memory */ } } return r; }

function hasSession(): boolean { return typeof window !== 'undefined'; }
function clearDraft(electionId = 'election-current'): void {
  memoryDraft = { electionId, selections: {}, expiresAt: Date.now() + DRAFT_TTL };
  if (hasSession()) window.sessionStorage.removeItem(DRAFT_KEY);
}
function readDraft(electionId = 'election-current'): BallotDraft {
  // Read the saved copy first: after a reload the in-memory draft is blank, and it must not wipe the saved one.
  if (hasSession()) {
    try {
      const saved = window.sessionStorage.getItem(DRAFT_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as BallotDraft;
        const fresh = typeof parsed.expiresAt === 'number' && parsed.expiresAt > Date.now() && !!parsed.selections;
        if (fresh && parsed.electionId === electionId) { memoryDraft = parsed; return memoryDraft; }
        if (fresh) return { electionId, selections: {}, expiresAt: Date.now() + DRAFT_TTL };   // a lookup for another election id must not wipe this one
        clearDraft(electionId);
        return memoryDraft;
      }
    } catch { clearDraft(electionId); return memoryDraft; }
  }
  if (memoryDraft.electionId !== electionId || memoryDraft.expiresAt <= Date.now()) clearDraft(electionId);
  return memoryDraft;
}
function writeDraft(selections: SelectionMap, electionId = 'election-current'): void {
  memoryDraft = { electionId, selections, expiresAt: Date.now() + DRAFT_TTL };
  if (hasSession()) window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(memoryDraft));
}

const ELECTION_ID = (import.meta.env.VITE_ELECTION_ID as string | undefined) ?? '';   // single-election deployments; multi-election selection comes later
async function liveAuth(path: string, body: Record<string, unknown>): Promise<ApiResult<{ displayName: string }>> {
  try {
    const csrf = (await (await fetch('/api/csrf', { credentials: 'same-origin' })).json()) as { token: string };
    const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.token }, body: JSON.stringify({ electionId: ELECTION_ID, ...body }) });
    if (res.status === 429) return { ok: false, message: 'Too many attempts. Try again in a minute.' };
    return res.ok ? { ok: true, data: { displayName: 'Voter' } } : { ok: false, message: GENERIC_FAILURE_MESSAGE };   // one message for every failure
  } catch { return { ok: false, message: GENERIC_FAILURE_MESSAGE }; }
}
type LiveContest = { id: string; positionTitle: string; seatCount: number; allowAbstain: boolean; candidates: { id: string; name: string; platformSummary: string | null }[] };
type LiveInfo = { organization: string; status: string; paused: boolean; frozen: boolean; opensAt: string | null; closesAt: string | null };
const PHASE: Record<string, Lifecycle> = { DRAFT: 'Draft', CONFIGURED: 'Setup', LOCKED: 'Setup', OPEN: 'Open', CLOSED: 'Closed', TALLIED: 'Closed', CERTIFIED: 'Certified', ARCHIVED: 'Certified' };
const AVATAR_HUES: [string, string][] = [['#0f766e', '#2a9d8f'], ['#4648b8', '#7a7de0'], ['#b83a58', '#e0708a'], ['#1d6fa5', '#4fa3d9'], ['#7a4fb0', '#a98bdc']];
function avatar(name: string): string {   // candidates have no photos yet: a friendly initials tile instead of a blank silhouette
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  const [a, b] = AVATAR_HUES[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_HUES.length]!;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="400" height="200" fill="url(#g)"/><circle cx="330" cy="30" r="90" fill="#fff" opacity=".08"/><circle cx="60" cy="190" r="70" fill="#fff" opacity=".08"/><text x="200" y="118" text-anchor="middle" font-family="Georgia,serif" font-size="72" font-weight="700" fill="#fff">${initials}</text></svg>`);
}
async function liveGet<T>(path: string): Promise<{ status: number; body: T | null }> {
  try { const r = await fetch(path, { credentials: 'same-origin' }); return { status: r.status, body: r.ok ? ((await r.json()) as T) : null }; } catch { return { status: 0, body: null }; }
}
async function livePostJson(path: string, body: unknown): Promise<{ status: number; body: { receipt?: string; error?: { code: string } } | null }> {
  try {
    const csrf = (await (await fetch('/api/csrf', { credentials: 'same-origin' })).json()) as { token: string };
    const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.token }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch { return { status: 0, body: null }; }
}
const FMT = (opts: Intl.DateTimeFormatOptions, d: Date) => d.toLocaleString('en-US', { timeZone: 'Asia/Manila', ...opts });
function when(iso: string | null | undefined): string {   // the UI shows "October 7, 2026 · 8:00 AM" in campus time
  const d = iso ? new Date(iso) : null; if (!d || Number.isNaN(d.getTime())) return '';
  return `${FMT({ month: 'long', day: 'numeric', year: 'numeric' }, d)} · ${FMT({ hour: 'numeric', minute: '2-digit' }, d)}`;
}
// One call builds the organization and election from the real server. Contests come only with a session (the server scopes them to the voter).
async function liveContext(): Promise<OrganizationElection> {
  const [infoRes, ballotRes] = await Promise.all([liveGet<LiveInfo>(`/api/elections/${ELECTION_ID}/info`), liveGet<{ contests: LiveContest[] }>(`/api/elections/${ELECTION_ID}/ballot`)]);
  const info = infoRes.body, signedIn = ballotRes.status === 200, name = info?.organization ?? 'Student';
  const open = info?.status === 'OPEN', held = open && (info?.paused || info?.frozen);
  const status: ElectionStatus = info?.status === 'CERTIFIED' || info?.status === 'ARCHIVED' ? 'Certified' : held ? 'Paused' : open ? 'Open' : info?.status === 'CLOSED' || info?.status === 'TALLIED' ? 'Closed' : 'Upcoming';
  const phase: Lifecycle = info?.frozen ? 'Frozen' : info?.paused ? 'Paused' : PHASE[info?.status ?? 'DRAFT'] ?? 'Draft';
  const organization: Organization = { id: 'live', name, short: name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase(), accent: 'Student election', electionId: ELECTION_ID };
  const election: Election = { id: ELECTION_ID, organizationId: 'live', title: `${name} election`, status, phase, opensAt: when(info?.opensAt), closesAt: when(info?.closesAt), turnout: 0, totalEligible: 0, signedIn,
    contests: (ballotRes.body?.contests ?? []).map((c) => ({ id: c.id, title: c.positionTitle, seats: c.seatCount, allowAbstain: c.allowAbstain,
      description: c.seatCount === 1 ? 'Choose one candidate for this position.' : `Select up to ${c.seatCount} candidates for this position.`,
      candidates: c.candidates.map((k) => ({ id: k.id, name: k.name, program: '', tag: c.positionTitle.toUpperCase(), photo: avatar(k.name), photoAlt: '', statement: k.platformSummary ?? '' })) })) };
  return { organization, election };
}
const liveElection = async (): Promise<Election> => (await liveContext()).election;
const REFUSAL: Record<string, string> = {   // cast_ballot refusals, in words a voter can act on
  ALREADY_VOTED: 'You have already voted in this election.',
  FROZEN: 'Voting is on hold for a moment. Your ballot has not been submitted. Try again in a few minutes.',
  PAUSED: 'Voting is on hold for a moment. Your ballot has not been submitted. Try again in a few minutes.',
  NOT_OPEN: 'Voting is not open yet.', WINDOW_CLOSED: 'Voting has closed.', CLOSED: 'Voting has closed.',
  WRONG_CHANNEL: 'Your account is set up to vote in person at the lab, not online. Ask a proctor for help.',
};
const HOLD = new Set(['FROZEN', 'PAUSED']);   // nothing was recorded, so the same nonce is safe to reuse
export const api = {
  async submitSupport(kind: SupportKind, fields: Record<string, string>): Promise<ApiResult<{ message: string; reference?: string }>> {
    try {
      const csrf = (await (await fetch('/api/csrf', { credentials: 'same-origin' })).json()) as { token: string };
      const body = kind === 'claim' ? { electionId: ELECTION_ID, studentId: fields.studentId, claimCode: fields.claimCode, password: fields.password } : { electionId: ELECTION_ID, ...fields };
      const res = await fetch(`/api/support/${kind}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.token }, body: JSON.stringify(body) });
      if (res.status === 429) return { ok: false, message: 'Too many attempts. Try again later.' };
      if (!res.ok) return { ok: false, message: GENERIC_FAILURE_MESSAGE };   // one message for every failure, so a claim form cannot be used to test codes or Student IDs
      if (kind === 'claim') return { ok: true, data: { message: 'Your account is ready. You can sign in now.' } };
      const reference = ((await res.json()) as { reference?: string }).reference;
      const next = kind === 'dispute' ? ' To get your account back, bring your school ID to the Electoral Committee. They can give you a claim code.' : '';
      return { ok: true, data: { reference, message: `Thank you. Your reference is ${reference}. Keep it: it is how the Electoral Committee finds your submission.${next}` } };
    } catch { return { ok: false, message: GENERIC_FAILURE_MESSAGE }; }
  },
  // The reset link is checked on arrival (the check does not use the link up), then used once by the form.
  async checkResetLink(token: string): Promise<boolean> {
    return !!token && (await liveGet<{ valid: boolean }>(`/api/auth/reset/${encodeURIComponent(token)}`)).body?.valid === true;
  },
  async resetPassword(token: string, newPassword: string): Promise<ApiResult<{ message: string }>> {
    try {
      const csrf = (await (await fetch('/api/csrf', { credentials: 'same-origin' })).json()) as { token: string };
      const res = await fetch('/api/auth/reset', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.token }, body: JSON.stringify({ token, newPassword }) });
      if (res.status === 429) return { ok: false, message: 'Too many attempts. Try again in a minute.' };
      return res.ok ? { ok: true, data: { message: 'Password updated. Sign in with your new password.' } } : { ok: false, message: 'This link is no longer valid. Request a new one.' };
    } catch { return { ok: false, message: GENERIC_FAILURE_MESSAGE }; }
  },
  async getOrganizations() { return [(await liveContext()).organization]; },
  async getElection(): Promise<Election> { return liveElection(); },
  async getCurrentElection(): Promise<Election> { return liveElection(); },
  async getOrganizationElection(_organizationId?: string): Promise<OrganizationElection> { return liveContext(); },   // single-election deployments: any organization id in the URL is ignored until the organization chooser exists
  async getResults(): Promise<ApiResult<CertifiedResult[]>> {
    // the server publishes nothing until two admins have certified; before that this is a plain "not yet"
      type Live = { published: boolean; certifiedAt: string; ballots: number; signingKey: string; signingKeyFingerprint: string; sets: ResultsProof['sets'];
        contests: { id: string; title: string; seats: number; abstain: number; candidates: { id: string; name: string; votes: number }[] }[] };
      const r = await liveGet<Live>(`/api/elections/${ELECTION_ID}/results`);
      if (!r.body?.published) { lastProof = null; return { ok: false, message: 'Results become available after the election is certified.' }; }
      lastProof = { ballots: r.body.ballots, signingKey: r.body.signingKey, signingKeyFingerprint: r.body.signingKeyFingerprint, sets: r.body.sets };
      return { ok: true, data: r.body.contests.map((c) => ({ contestId: c.id, title: c.title, certifiedAt: when(r.body!.certifiedAt), seats: c.seats, abstain: c.abstain, candidates: c.candidates })) };
  },
  getResultsProof(): ResultsProof | null { return lastProof; },
  async getStatus(): Promise<{ eligible: boolean; ballot: 'not-started' | 'voted'; message: string; signedIn?: boolean }> {
    { const me = await liveGet<{ hasVoted: boolean }>('/api/me');
      if (!me.body) return { eligible: false, ballot: 'not-started', message: 'Sign in to see your voting status.', signedIn: false };
      return { eligible: true, signedIn: true, ballot: me.body.hasVoted ? 'voted' : 'not-started', message: me.body.hasVoted ? 'Your ballot was recorded. We are checking that it was counted.' : 'You’re eligible to vote in this election.' }; }
  },
  getReceipt(): Receipt | null {
    if (!lastReceipt && hasSession()) { try { const saved = sessionStorage.getItem(RECEIPT_KEY); if (saved) lastReceipt = JSON.parse(saved) as Receipt; } catch { /* ignore */ } }
    return lastReceipt; },
  getDraft(electionId = 'election-current'): BallotDraft { return readDraft(electionId); },
  saveSelections(selections: SelectionMap, electionId = 'election-current'): void { writeDraft(selections, electionId); },
  clearBallot(reason: 'submit' | 'expiry' | 'logout', electionId = 'election-current'): void {
    clearDraft(electionId);
    if (reason === 'logout') keepReceipt(null);
  },
  async submitBallot(electionId = 'election-current'): Promise<Receipt> {
    {
      const draft = readDraft(electionId), b = await liveGet<{ contests: LiveContest[] }>(`/api/elections/${ELECTION_ID}/ballot`);
      if (!b.body) throw new Error('Your session expired. Sign in again to submit your ballot.');
      // The draft stores abstain as the marker 'abstain'. It is translated here and is never sent as a candidate id.
      const selections = b.body.contests.map((c) => {
        const ids = draft.selections[c.id] ?? [], abstain = ids.includes('abstain'), candidateIds = abstain ? [] : ids.filter((id) => id !== 'abstain');
        if (!abstain && candidateIds.length === 0) throw new Error(`Choose a candidate or abstain for ${c.positionTitle} before submitting.`);   // never turn "no answer" into an abstention
        if (abstain && !c.allowAbstain) throw new Error(`${c.positionTitle} does not allow abstaining. Choose a candidate.`);
        return { contestId: c.id, candidateIds, abstain };
      });
      const nonceKey = `ctuvote:nonce:${ELECTION_ID}`, nonce = sessionStorage.getItem(nonceKey) ?? crypto.randomUUID(); sessionStorage.setItem(nonceKey, nonce);   // same nonce on retry, so a retry can never double-vote
      const r = await livePostJson(`/api/elections/${ELECTION_ID}/ballot`, { nonce, round: 1, selections });
      if (r.status === 200 && r.body?.receipt) { sessionStorage.removeItem(nonceKey); clearDraft(electionId);
        return keepReceipt({ id: r.body.receipt.slice(0, 12).toUpperCase(), hash: r.body.receipt, recordedAt: new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }), state: 'recorded' })!; }
      const code = r.body?.error?.code ?? '';
      if (r.status === 401) throw new Error('Your session expired. Sign in again to submit your ballot.');
      if (HOLD.has(code)) throw new Error(REFUSAL[code]);
      if (REFUSAL[code]) { sessionStorage.removeItem(nonceKey); throw new Error(REFUSAL[code]); }
      if (r.status === 400 || r.status === 409) { sessionStorage.removeItem(nonceKey); throw new Error('Your ballot could not be accepted. Review your selections and try again.'); }
      throw new Error('We are checking your vote. Check your status before trying again.');   // network or server trouble: keep the nonce, never blind-resubmit
    }
  },
  async checkReceipt(code: string): Promise<'sealed' | 'recorded' | 'unknown' | 'invalid' | 'busy' | 'error'> {
    const h = code.trim().toLowerCase().replace(/\s+/g, '');
    if (!/^[0-9a-f]{64}$/.test(h)) return 'invalid';
    const r = await liveGet<{ recorded: boolean; sealed: boolean }>(`/api/elections/${ELECTION_ID}/receipt/${h}`);
    if (r.status === 429) return 'busy';
    if (!r.body) return r.status === 404 ? 'unknown' : 'error';
    return r.body.sealed ? 'sealed' : r.body.recorded ? 'recorded' : 'unknown';
  },
  sealReceipt(): Receipt | null {
    {   // poll the chain; the next call returns the sealed state once the sealer has run
      if (lastReceipt?.state === 'recorded') void liveGet<{ sealed: boolean }>(`/api/elections/${ELECTION_ID}/receipt/${lastReceipt.hash}`).then((r) => { if (r.body?.sealed && lastReceipt) keepReceipt({ ...lastReceipt, state: 'sealed' }); });
      return lastReceipt; }
  },
  async authenticate(request: AuthRequest): Promise<ApiResult<{ displayName: string }>> {
    return liveAuth('/api/auth/login', { studentId: request.identifier, password: request.password });
  },
  async register(request: RegisterRequest): Promise<ApiResult<{ displayName: string }>> {
    { const r = await liveAuth('/api/auth/register', { studentId: request.studentId, voucher: request.voucher, password: request.password, termsAccepted: request.termsAccepted });
      return r.ok ? liveAuth('/api/auth/login', { studentId: request.studentId, password: request.password }) : r; }
  },
  async requestPasswordReset(identifier: string): Promise<ApiResult<{ message: string }>> {
    { const r = await liveAuth('/api/auth/forgot', { studentId: identifier }); return r.ok || r.message.startsWith('Too many') ? (r.ok ? { ok: true, data: { message: SUPPORT_DONE } } : r) : { ok: true, data: { message: SUPPORT_DONE } }; }
  },
  async hasSession(): Promise<boolean> { return (await liveGet('/api/me')).status === 200; },
  async logout(): Promise<void> {   // ends the SERVER session first; local state is cleared even if the call fails
    await livePostJson('/api/auth/logout', {}); sessionStorage.removeItem(`ctuvote:nonce:${ELECTION_ID}`);
    api.clearBallot('logout');
  },
  genericFailure(): string { return GENERIC_FAILURE_MESSAGE; },
};
export { when as formatWhen };
