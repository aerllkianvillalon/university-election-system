// Staff console API (live server only). Every refusal the server can give has a plain-English message here; nothing shows a raw code to a person.
export type StaffElection = { id: string; status: string; paused: boolean; frozen: boolean; opensAt: string | null; closesAt: string | null; certifiedAt: string | null; freezeByMe: boolean; freezeConfirmed: boolean };
export type StaffMe = { name: string; username: string; role: string; organization: string; elections: StaffElection[]; recoveryCodesLeft: number; recovered: boolean };
export type Person = { id: string; name: string; username: string; role: 'ADMIN' | 'PROCTOR' | 'OBSERVER'; status: 'INVITED' | 'ACTIVE' | 'DISABLED'; createdAt: string; me: boolean };
export type PersonRequest = { id: string; action: 'invite' | 'disable' | 'reinvite'; target: string; initiator: string; mine: boolean; createdAt: string };
export type Revealed = { pending: false; action: string; username: string; setupCode?: string; validDays?: number } | { pending: true; id: string };
export type Pending = { id: string; action: string; params: { minutes?: number }; createdAt: string; initiator: string; mine: boolean };
export type Done = { action: string; params: { minutes?: number }; initiator: string; approver: string; at: string };
export type Readiness = { ready: boolean; checks: { name: string; ok: boolean; detail: string }[] };
export type Turnout = { eligible: number; online: number; lab: number };
export type SupportRow = { id: string; ref: string; kind: 'protest' | 'dispute' | 'report'; student_id: string | null; subject: string | null; details: string; url: string | null; on_roll: boolean; session_verified: boolean; status: string; note: string | null; created_at: string };
export type ResultsStatus = { status: string; inbox: number; participation: number; chains: { chain: string; ballots: number; imported: boolean; matches: boolean }[]; certifyBlocker: string | null };
export type AuditEntry = { seq: number; at: string; action: string; by: string | null; detail: Record<string, unknown>; hash: string };
export type AuditCheck = { ok: boolean; checked: number; head: string };
export type Call<T> = { ok: true; data: T } | { ok: false; code: string; status: number; message: string };

export const ACTIONS = ['lock', 'open', 'pause', 'resume', 'extend', 'close', 'unfreeze', 'certify'] as const;
export type ActionName = (typeof ACTIONS)[number];

const MESSAGES: Record<string, string> = {
  SESSION_ENDED: 'Your session ended. Sign in again.',
  FORBIDDEN: 'Your account is not allowed to do that.',
  SAME_ADMIN: 'Another administrator has to approve this. You made the request yourself.',
  SAME_ADMIN_OR_BAD_STATE: 'A different administrator has to confirm this, and only while the freeze is active.',
  NOT_FOUND: 'That item no longer exists or has already been handled.',
  VALIDATION_FAILED: 'Check what you entered and try again.',
  RATE_LIMITED: 'Too many attempts. Wait a few minutes and try again.',
  GATE_BAD_STATE: 'That is not possible in the election’s current state.',
  GATE_NO_ELECTION: 'That election does not exist.',
  GATE_NO_POSITIONS: 'The election has no positions yet.',
  GATE_POSITION_WITHOUT_CANDIDATES: 'A position has no candidates yet.',
  GATE_NO_VOTERS: 'The voter roll is empty.',
  GATE_NO_ELECTION_KEY: 'The election key has not been registered.',
  GATE_NO_SIGNING_KEY: 'The results signing key has not been registered.',
  GATE_NO_WINDOW: 'The opening and closing times are not set correctly.',
  GATE_EXTENSION_CAP: 'An extension must be between 1 and 1,440 minutes.',
  GATE_FROZEN: 'Voting is frozen. Resolve the freeze first.',
  GATE_UNSEALED_BALLOTS: 'Some ballots are still in the inbox and have not been sealed into the chain yet.',
  GATE_CHAIN_BROKEN: 'A ballot chain does not verify. Stop and investigate before going further.',
  GATE_RESULTS_MISSING: 'A signed tally is still missing for at least one chain that holds ballots.',
  GATE_RESULTS_STALE: 'A signed tally no longer matches the chain it was made from.',
  GATE_PARTICIPATION_MISMATCH: 'The number of people recorded as voted does not equal the number of ballots counted.',
  GATE_BAD_SIGNATURE: 'The signature does not match the election’s registered signing key. Nothing was imported.',
  GATE_RESULTS_MISMATCH: 'The tally does not match the ballots in the database (count, chain or chain tip). Nothing was imported.',
  GATE_RESULTS_INVALID: 'The tally contains numbers or ids that cannot be right for this election. Nothing was imported.',
  GATE_ALREADY_IMPORTED: 'A tally for that chain was already imported.',
  GATE_BAD_KEY: 'That is not a valid key.',
  WRONG_PASSWORD: 'That is not your current password.',
  PASSWORD_TOO_SHORT: 'Use at least 12 characters for the password.',
  PASSWORD_UNCHANGED: 'Choose a different password from the current one.',
  BAD_CODE: 'That code did not match. Check your authenticator app and try again.',
  GATE_USERNAME_TAKEN: 'That username is already in use.',
  GATE_BAD_DETAILS: 'Use a name, and a username of 3 to 32 lower-case letters, numbers, dots, dashes or underscores.',
  GATE_SELF: 'You cannot do that to your own account.',
  GATE_TOO_FEW_ADMINS: 'That would leave fewer than two active administrators, and the two-person rules need two.',
};
export const explain = (code: string | null | undefined): string => (code ? MESSAGES[code] ?? 'That is not allowed right now.' : '');

async function csrf(): Promise<string> { return ((await (await fetch('/api/csrf', { credentials: 'same-origin' })).json()) as { token: string }).token; }
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Call<T>> {
  try {
    const res = await fetch(path, { method, credentials: 'same-origin', headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrf() } : {}, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
    const json = (await res.json().catch(() => null)) as (T & { error?: { code?: string } }) | null;
    if (res.ok) return { ok: true, data: json as T };
    const raw = json?.error?.code ?? '';
    const code = res.status === 429 ? 'RATE_LIMITED' : res.status === 401 && raw === 'MFA_REQUIRED' ? 'SESSION_ENDED' : raw || 'ERROR';
    return { ok: false, code, status: res.status, message: explain(code) };
  } catch { return { ok: false, code: 'NETWORK', status: 0, message: 'Cannot reach the server. Check your connection and try again.' }; }
}

const R = (id: string) => `/api/admin/elections/${id}`;
export const staff = {
  async login(username: string, password: string): Promise<'mfa' | 'failed' | 'limited' | 'network'> {
    const r = await call<{ mfaRequired: boolean }>('POST', '/api/staff/login', { username, password });
    return r.ok ? 'mfa' : r.code === 'RATE_LIMITED' ? 'limited' : r.code === 'NETWORK' ? 'network' : 'failed';
  },
  async mfa(code: string): Promise<'ok' | 'failed' | 'limited' | 'network'> {
    const r = await call<{ ok: boolean }>('POST', '/api/staff/mfa', { code });
    return r.ok ? 'ok' : r.code === 'RATE_LIMITED' ? 'limited' : r.code === 'NETWORK' ? 'network' : 'failed';
  },
  mfaRecovery: async (recoveryCode: string): Promise<'ok' | 'failed' | 'limited' | 'network'> => {
    const r = await call<{ ok: boolean }>('POST', '/api/staff/mfa', { recoveryCode });
    return r.ok ? 'ok' : r.code === 'RATE_LIMITED' ? 'limited' : r.code === 'NETWORK' ? 'network' : 'failed';
  },
  me: () => call<StaffMe>('GET', '/api/staff/me'),
  // first-time setup with a one-time setup code (no session yet)
  setupStart: (username: string, setupCode: string) => call<{ name: string; role: string; secret: string; uri: string }>('POST', '/api/staff/setup/start', { username, setupCode }),
  setupFinish: (username: string, setupCode: string, password: string, code: string) => call<{ ok: boolean; recoveryCodes: string[] }>('POST', '/api/staff/setup/finish', { username, setupCode, password, code }),
  // your own account
  changePassword: (current: string, next: string) => call<{ ok: boolean }>('POST', '/api/staff/password', { current, next }),
  startAuthenticator: (password: string) => call<{ secret: string; uri: string }>('POST', '/api/staff/authenticator/start', { password }),
  confirmAuthenticator: (code: string) => call<{ ok: boolean }>('POST', '/api/staff/authenticator/confirm', { code }),
  newRecoveryCodes: (password: string) => call<{ recoveryCodes: string[] }>('POST', '/api/staff/recovery-codes', { password }),
  // people (administrators)
  people: () => call<{ staff: Person[]; pending: PersonRequest[] }>('GET', '/api/admin/staff'),
  invite: (name: string, username: string, role: string) => call<Revealed>('POST', '/api/admin/staff/invite', { name, username, role }),
  disable: (id: string) => call<Revealed>('POST', `/api/admin/staff/${id}/disable`),
  reinvite: (id: string) => call<Revealed>('POST', `/api/admin/staff/${id}/reinvite`),
  approvePerson: (requestId: string) => call<Revealed>('POST', `/api/admin/staff-requests/${requestId}/approve`),
  cancelPerson: (requestId: string) => call<{ ok: boolean }>('POST', `/api/admin/staff-requests/${requestId}/cancel`),
  logout: () => call<{ ok: boolean }>('POST', '/api/staff/logout'),
  readiness: (id: string) => call<Readiness>('GET', `${R(id)}/readiness`),
  turnout: (id: string) => call<Turnout>('GET', `${R(id)}/turnout`),
  approvals: (id: string) => call<{ pending: Pending[]; recent: Done[] }>('GET', `${R(id)}/approvals`),
  request: (id: string, action: ActionName, params?: { minutes: number }) => call<{ approvalId: string }>('POST', `${R(id)}/actions`, { action, params }),
  approve: (approvalId: string) => call<{ ok: boolean }>('POST', `/api/admin/approvals/${approvalId}/approve`),
  cancel: (approvalId: string) => call<{ ok: boolean }>('POST', `/api/admin/approvals/${approvalId}/cancel`),
  freeze: (id: string) => call<{ ok: boolean }>('POST', `${R(id)}/freeze`),
  ratifyFreeze: (id: string) => call<{ ok: boolean }>('POST', `${R(id)}/ratify-freeze`),
  support: (id: string, status: string, kind: string) => call<{ requests: SupportRow[] }>('GET', `${R(id)}/support?${new URLSearchParams({ ...(status ? { status } : {}), ...(kind ? { kind } : {}) })}`),
  setSupportStatus: (requestId: string, status: string, note: string) => call<{ ok: boolean }>('POST', `/api/admin/support/${requestId}/status`, { status, note: note || null }),
  issueClaimCode: (id: string, studentId: string) => call<{ studentId: string; claimCode: string; validDays: number }>('POST', `${R(id)}/claim-codes`, { studentId }),
  audit: (before?: number) => call<{ entries: AuditEntry[] }>('GET', `/api/admin/audit?${new URLSearchParams({ limit: '50', ...(before ? { before: String(before) } : {}) })}`),
  auditCheck: () => call<AuditCheck>('GET', '/api/admin/audit/check'),
  resultsStatus: (id: string) => call<ResultsStatus>('GET', `${R(id)}/results`),
  importResults: (id: string, results: { body: string; signature: string }) => call<{ chain: string; ballots: number; status: string }>('POST', `${R(id)}/results`, { results }),
};
