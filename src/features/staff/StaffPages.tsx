// Staff console (live server only): sign-in with authenticator code, then the operate-and-oversee screens for an election's administrators.
// Two-person rule: a request is made by one administrator and approved by a DIFFERENT one from their own session. Nothing here can approve your own request.
import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { ActionLink, Button, Card, Eyebrow, StatCard, StatusPill } from '../../components/ui/Primitives';
import { formatWhen } from '../../lib/api/client';
import { ACTIONS, explain, staff, type ActionName, type AuditCheck, type AuditEntry, type Call, type Done, type Pending, type Person, type PersonRequest, type Readiness, type ResultsStatus, type Revealed, type StaffElection, type StaffMe, type SupportRow, type Turnout } from '../../lib/api/staff';


// ---------------------------------------------------------------- sign in
function LoginForm() {
  const nav = useNavigate(); const [params] = useSearchParams();
  const [step, setStep] = useState<'password' | 'code'>('password'); const [recovery, setRecovery] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { void staff.me().then((r) => { if (r.ok) nav('/staff', { replace: true }); }); }, [nav]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true); const form = new FormData(event.currentTarget);
    try {
      if (step === 'password') {
        const r = await staff.login(String(form.get('username') || '').trim(), String(form.get('password') || ''));
        if (r === 'mfa') setStep('code'); else setError(r === 'limited' ? 'Too many attempts. Wait a few minutes and try again.' : r === 'network' ? 'Cannot reach the server.' : 'Check your username and password.');
      } else {
        const r = recovery ? await staff.mfaRecovery(String(form.get('recovery') || '').trim()) : await staff.mfa(String(form.get('code') || '').trim());
        if (r === 'ok') nav('/staff', { replace: true }); else setError(r === 'limited' ? 'Too many attempts. Wait a few minutes and start again.' : recovery ? 'That recovery code did not work. Each code works once. Check it, or start over.' : 'That code did not work. Check the 6-digit code in your authenticator app, use a recovery code, or start over.');
      }
    } finally { setBusy(false); }
  }
  return <><div className="page-head"><div><Eyebrow>Staff</Eyebrow><h1>Staff <span className="highlight-word">sign-in.</span></h1><p>For election administrators. You will need your authenticator app.</p></div></div>
    <Card className="form-card" style={{ maxWidth: 460 }}>
      {params.get('ended') && <div className="form-message" role="status">Your session ended. Sign in again.</div>}
      <form noValidate onSubmit={submit} key={step}>
        {step === 'password' ? <>
          <div className="field"><label htmlFor="username">Username</label><input id="username" name="username" autoComplete="username" required /></div>
          <div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required /></div></> :
          (recovery ? <div className="field"><label htmlFor="recovery">Recovery code</label><input id="recovery" name="recovery" autoComplete="off" maxLength={24} required /><small>One of the codes you saved when you set up your account. Each works once.</small></div>
            : <div className="field"><label htmlFor="code">6-digit code</label><input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /><small>From your authenticator app. Each code works once.</small></div>)}
        {error && <div className="form-message" role="alert">{error}</div>}
        <Button className="btn-block" type="submit" disabled={busy}>{busy ? 'Please wait…' : step === 'password' ? 'Continue' : 'Sign in'}</Button>
        {step === 'code' && <p><button type="button" className="link-button" onClick={() => { setRecovery((r) => !r); setError(''); }}>{recovery ? 'Use my authenticator app instead' : 'I cannot use my authenticator: use a recovery code'}</button></p>}
        {step === 'code' && <p><button type="button" className="link-button" onClick={() => { setStep('password'); setRecovery(false); setError(''); }}>Start over</button></p>}
      </form></Card></>;
}
export const StaffLogin = () => <LoginForm />;

// ---------------------------------------------------------------- first-time setup with a one-time code
const groups = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();
function SetupForm() {
  const [step, setStep] = useState<'code' | 'enroll' | 'done'>('code'); const [who, setWho] = useState({ username: '', setupCode: '' });
  const [info, setInfo] = useState<{ name: string; role: string; secret: string; uri: string } | null>(null); const [codes, setCodes] = useState<string[]>([]); const [saved, setSaved] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true); const f = new FormData(event.currentTarget);
    try {
      if (step === 'code') {
        const username = String(f.get('username') || '').trim(), setupCode = String(f.get('setupCode') || '').trim(); const r = await staff.setupStart(username, setupCode);
        if (r.ok) { setWho({ username, setupCode }); setInfo(r.data); setStep('enroll'); } else setError(r.code === 'RATE_LIMITED' ? r.message : 'That username and setup code do not match, or the code has expired or been used. Ask the person who gave it to you.');
      } else {
        const password = String(f.get('password') || '');
        if (password !== String(f.get('confirm') || '')) return setError('The two passwords do not match.');
        const r = await staff.setupFinish(who.username, who.setupCode, password, String(f.get('code') || '').trim());
        if (r.ok) { setCodes(r.data.recoveryCodes); setStep('done'); } else setError(r.code === 'PASSWORD_TOO_SHORT' || r.code === 'RATE_LIMITED' ? r.message : 'The 6-digit code did not match, or the setup code has expired. Check your authenticator app and try again.');
      }
    } finally { setBusy(false); }
  }
  return <><div className="page-head"><div><Eyebrow>Staff</Eyebrow><h1>Set up your <span className="highlight-word">account.</span></h1><p>You need the one-time setup code you were given in person.</p></div></div>
    <Card className="form-card" style={{ maxWidth: 560 }}>
      {step === 'code' && <form noValidate onSubmit={submit}>
        <div className="field"><label htmlFor="username">Username</label><input id="username" name="username" autoComplete="username" required /></div>
        <div className="field"><label htmlFor="setup-code">Setup code</label><input id="setup-code" name="setupCode" autoComplete="off" required /><small>Looks like ABCD-EFGH-JKMN. It works once.</small></div>
        {error && <div className="form-message" role="alert">{error}</div>}<Button className="btn-block" type="submit" disabled={busy}>{busy ? 'Please wait…' : 'Continue'}</Button></form>}
      {step === 'enroll' && info && <form noValidate onSubmit={submit}>
        <p>Welcome, <strong>{info.name}</strong>. Two things to do: connect your authenticator app, then choose a password.</p>
        <h2 style={{ ...h2, fontSize: 16 }}>1. Connect your authenticator app</h2>
        <p style={{ fontSize: 13 }}>In your authenticator app choose “enter a setup key” and type this key. Or <a href={info.uri}>open it in your authenticator app</a> on this device.</p>
        <p><code aria-label="Authenticator setup key" style={{ fontSize: 18, letterSpacing: 1, wordBreak: 'break-all' }}>{groups(info.secret)}</code></p>
        <h2 style={{ ...h2, fontSize: 16 }}>2. Choose your password</h2>
        <div className="field"><label htmlFor="password">Password (at least 12 characters)</label><input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required /></div>
        <div className="field"><label htmlFor="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} required /></div>
        <h2 style={{ ...h2, fontSize: 16 }}>3. Prove it works</h2>
        <div className="field"><label htmlFor="code">6-digit code from the app</label><input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></div>
        {error && <div className="form-message" role="alert">{error}</div>}<Button className="btn-block" type="submit" disabled={busy}>{busy ? 'Please wait…' : 'Finish setup'}</Button></form>}
      {step === 'done' && <div><div className="form-message" role="status">Your account is ready.</div>
        <h2 style={{ ...h2, fontSize: 16 }}>Save your recovery codes</h2><p style={{ fontSize: 13 }}>If you lose your phone, each of these lets you sign in once. They are shown only now. Keep them somewhere safe and separate from your phone.</p>
        <ul className="plain-list recovery" aria-label="Recovery codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
        <label className="checkline"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> <span>I have saved these recovery codes.</span></label>
        {saved ? <p><ActionLink to="/staff/login">Go to sign-in</ActionLink></p> : <p style={{ color: 'var(--muted)', fontSize: 13 }}>Tick the box to continue. Then wait for your app to show a new code and sign in with it.</p>}</div>}
    </Card></>;
}
export const StaffSetup = () => <SetupForm />;

// ---------------------------------------------------------------- console
type Say = (kind: 'ok' | 'err', text: string) => void;
const Tools = createContext<{ fail: (r: Extract<Call<unknown>, { ok: false }>) => void; say: Say; refresh: () => Promise<void> }>(null as never);
const Ctx = createContext<{ election: StaffElection; tick: number; bump: () => void; fail: (r: Extract<Call<unknown>, { ok: false }>) => void; say: Say }>(null as never);
const STATUS: Record<string, string> = { DRAFT: 'Draft', CONFIGURED: 'Set up', LOCKED: 'Locked', OPEN: 'Open', CLOSED: 'Closed', TALLIED: 'Tallied, not yet certified', CERTIFIED: 'Certified', ARCHIVED: 'Archived' };
const CHECKS: Record<string, string> = { positions_exist: 'Positions exist', every_position_has_candidates: 'Every position has candidates', roll_imported: 'Voter roll imported', election_key_set: 'Election key registered', signing_key_set: 'Results signing key registered', window_set: 'Opening and closing times set', online_voters_have_vouchers: 'Every online voter has a voucher', lab_booths_registered: 'Lab booths registered', chain_verifies: 'Ballot chain verifies' };
const INFO: Record<ActionName, { label: string; effect: string; final: boolean }> = {
  lock: { label: 'Lock the election', effect: 'Positions, candidates and the voter roll can no longer be edited.', final: true },
  open: { label: 'Open voting', effect: 'Voting starts immediately. This cannot be undone.', final: true },
  pause: { label: 'Pause voting', effect: 'Voters are told voting is on hold. It can be resumed.', final: false },
  resume: { label: 'Resume voting', effect: 'Voting continues.', final: false },
  extend: { label: 'Extend voting', effect: 'Adds minutes to the closing time.', final: false },
  close: { label: 'Close voting', effect: 'No more ballots are accepted. This cannot be undone.', final: true },
  unfreeze: { label: 'Lift the freeze', effect: 'Voting can continue after the freeze.', final: false },
  certify: { label: 'Certify the results', effect: 'The counts become public to everyone. This cannot be undone.', final: true },
};
const label = (a: string, p?: { minutes?: number }) => a in INFO ? INFO[a as ActionName].label + (a === 'extend' && p?.minutes ? ` by ${p.minutes} minutes` : '') : a;
const h2 = { font: '700 20px var(--display)', margin: '0 0 12px' } as const;
const Section = ({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: ReactNode }) => <section id={id} aria-labelledby={`${id}-h`} className="home-section"><Eyebrow>{eyebrow}</Eyebrow><h2 id={`${id}-h`} style={h2}>{title}</h2>{children}</section>;

// What the committee and auditors can read: who did what, newest first. Each row commits to the one before it, so "Check the chain" proves nothing was removed or edited.
function AuditLog() {
  const { fail } = useContext(Ctx); const [rows, setRows] = useState<AuditEntry[]>([]); const [more, setMore] = useState(false); const [chk, setChk] = useState<AuditCheck | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async (before?: number) => { setBusy(true); try { const r = await staff.audit(before); if (!r.ok) return fail(r); setRows((cur) => (before ? [...cur, ...r.data.entries] : r.data.entries)); setMore(r.data.entries.length === 50); } finally { setBusy(false); } }, [fail]);
  useEffect(() => { void load(); }, [load]);
  async function check() { const r = await staff.auditCheck(); if (!r.ok) return fail(r); setChk(r.data); }
  const short = (d: Record<string, unknown>) => Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ');
  return <Section id="audit" eyebrow="06 · Audit log" title="What was done, and by whom"><Card>
    <p>Every sensitive action is recorded here. Entries are linked to each other, so a removed or changed entry shows up as a broken chain.</p>
    <div className="control-row"><Button variant="secondary" onClick={() => void check()}>Check the chain</Button>{chk && <span role="status">{chk.ok ? `Chain intact: ${chk.checked.toLocaleString()} entries, latest ${chk.head}.` : `Chain BROKEN after entry ${chk.checked.toLocaleString()}. Stop and investigate.`}</span>}</div>
    <table className="results-table"><caption className="sr-only">Audit log, newest first</caption><thead><tr><th scope="col">When</th><th scope="col">Action</th><th scope="col">By</th><th scope="col">Details</th></tr></thead>
      <tbody>{rows.length ? rows.map((r) => <tr key={r.seq}><td>{formatWhen(r.at)}</td><th scope="row">{r.action.replace(/_/g, ' ').toLowerCase()}</th><td>{r.by ?? 'system'}</td><td style={{ overflowWrap: 'anywhere' }}>{short(r.detail)}</td></tr>) : <tr><td colSpan={4}>Nothing has been recorded yet.</td></tr>}</tbody></table>
    {more && <Button variant="quiet" disabled={busy} onClick={() => void load(rows[rows.length - 1]?.seq)}>Show older entries</Button>}
  </Card></Section>;
}

function Console() {
  const nav = useNavigate(); const [me, setMe] = useState<StaffMe | null>(null); const [eid, setEid] = useState(''); const [tick, setTick] = useState(0); const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const say: Say = useCallback((kind, text) => setFlash({ kind, text }), []);
  const fail = useCallback((r: Extract<Call<unknown>, { ok: false }>) => { if (r.code === 'SESSION_ENDED') nav('/staff/login?ended=1', { replace: true }); else say('err', r.message); }, [nav, say]);
  const refresh = useCallback(async () => { const r = await staff.me(); if (!r.ok) return fail(r); setMe(r.data); setEid((cur) => cur || r.data.elections[0]?.id || ''); }, [fail]);
  useEffect(() => { void refresh(); }, [refresh]);
  const bump = useCallback(() => { setTick((t) => t + 1); void refresh(); }, [refresh]);
  async function signOut() { await staff.logout(); nav('/staff/login', { replace: true }); }
  if (!me) return <p role="status">Loading…</p>;
  const election = me.elections.find((e) => e.id === eid);
  return <><div className="page-head"><div><Eyebrow>{me.organization} · staff</Eyebrow><h1>Election <span className="highlight-word">operations.</span></h1><p>Signed in as {me.name}. Your session ends 15 minutes after you sign in.</p></div><Button variant="quiet" onClick={() => void signOut()}><LogOut size={15} /> Sign out</Button></div>
    <Tools.Provider value={{ fail, say, refresh }}>
    {me.recovered && <div className="form-message" role="alert">You signed in with a recovery code. Replace your authenticator now, then make a new set of recovery codes. <a href="#account">Go to your account</a></div>}
    {me.role !== 'ADMIN' ? <><Card className="empty-state"><h2>This console is for administrators.</h2><p>Your account is a {me.role.toLowerCase()} account. You can still manage your own sign-in below.</p></Card><Account me={me} /></>
      : !election ? <Card className="empty-state"><h2>No election yet.</h2><p>This organization has no election to manage.</p></Card>
      : <Ctx.Provider value={{ election, tick, bump, fail, say }}>
        {me.elections.length > 1 && <div className="field"><label htmlFor="election-pick">Election</label><select id="election-pick" value={eid} onChange={(e) => setEid(e.target.value)}>{me.elections.map((e) => <option key={e.id} value={e.id}>{STATUS[e.status] ?? e.status} · {formatWhen(e.opensAt) || 'no date'}</option>)}</select></div>}
        <nav aria-label="Console sections" className="control-row">{[['summary', 'Summary'], ['controls', 'Approvals and controls'], ['support', 'Support requests'], ['results', 'Results'], ['people', 'People'], ['audit', 'Audit log'], ['account', 'Your account']].map(([id, t]) => <a key={id} href={`#${id}`}>{t}</a>)}</nav>
        <Summary /><Controls /><Support /><Results /><People /><AuditLog /><Account me={me} />
      </Ctx.Provider>}
    </Tools.Provider>
    {flash && <div className="form-message" role={flash.kind === 'err' ? 'alert' : 'status'} style={{ position: 'sticky', bottom: 10, zIndex: 5 }}>{flash.text} <button type="button" className="link-button" onClick={() => setFlash(null)}>Dismiss</button></div>}
  </>;
}
export const StaffConsole = () => <Console />;

function Summary() {
  const { election: e, tick, fail } = useContext(Ctx); const [ready, setReady] = useState<Readiness | null>(null); const [turn, setTurn] = useState<Turnout | null>(null);
  useEffect(() => { let on = true; void Promise.all([staff.readiness(e.id), staff.turnout(e.id)]).then(([a, b]) => { if (!on) return; a.ok ? setReady(a.data) : fail(a); b.ok ? setTurn(b.data) : fail(b); }); return () => { on = false; }; }, [e.id, tick, fail]);
  const cast = (turn?.online ?? 0) + (turn?.lab ?? 0);
  return <Section id="summary" eyebrow="01 · Summary" title="Where the election stands"><Card>
    <div className="control-row"><StatusPill tone={e.status === 'OPEN' && !e.paused && !e.frozen ? 'success' : 'warning'}>{STATUS[e.status] ?? e.status}</StatusPill>{e.paused && <StatusPill tone="warning">Paused</StatusPill>}{e.frozen && <StatusPill tone="alert">Frozen</StatusPill>}</div>
    <p style={{ color: 'var(--muted)', fontSize: 13 }}>Opens {formatWhen(e.opensAt) || 'not set'} · Closes {formatWhen(e.closesAt) || 'not set'}{e.certifiedAt ? ` · Certified ${formatWhen(e.certifiedAt)}` : ''}</p>
    <div className="admin-grid"><StatCard label="Eligible voters" value={(turn?.eligible ?? 0).toLocaleString()} /><StatCard label="Voted online" value={(turn?.online ?? 0).toLocaleString()} /><StatCard label="Voted in a lab" value={(turn?.lab ?? 0).toLocaleString()} /><StatCard label="Turnout" value={turn?.eligible ? `${Math.round((cast / turn.eligible) * 100)}%` : '—'} note="Counts only. No choices are visible." /></div>
    <h3 style={{ margin: '18px 0 8px' }}>Readiness checks</h3>
    <ul className="readiness-list">{ready?.checks.map((c) => <li key={c.name}><span aria-hidden="true">{c.ok ? '✓' : '✗'}</span> <span>{CHECKS[c.name] ?? c.name}</span> <strong>{c.ok ? 'Done' : 'Not done'}</strong>{!c.ok && c.detail ? <small> · {c.detail}</small> : null}</li>)}</ul>
  </Card></Section>;
}

type Confirm = { kind: 'request'; action: ActionName } | { kind: 'approve'; id: string; action: ActionName } | { kind: 'freeze' } | { kind: 'ratify' };
function Controls() {
  const { election: e, tick, bump, fail, say } = useContext(Ctx); const [q, setQ] = useState<{ pending: Pending[]; recent: Done[] } | null>(null); const [confirm, setConfirm] = useState<Confirm | null>(null); const [minutes, setMinutes] = useState('30'); const [busy, setBusy] = useState(false);
  useEffect(() => { let on = true; void staff.approvals(e.id).then((r) => { if (!on) return; r.ok ? setQ(r.data) : fail(r); }); return () => { on = false; }; }, [e.id, tick, fail]);
  const s = e.status, available = ACTIONS.filter((a) => (a === 'lock' && (s === 'DRAFT' || s === 'CONFIGURED')) || (a === 'open' && s === 'LOCKED') || (a === 'pause' && s === 'OPEN' && !e.paused) || (a === 'resume' && e.paused) || ((a === 'extend' || a === 'close') && s === 'OPEN') || (a === 'unfreeze' && e.frozen) || (a === 'certify' && s === 'TALLIED'));
  async function go() {
    if (!confirm) return; setBusy(true);
    try {
      let r: Call<unknown>;
      if (confirm.kind === 'request') r = await staff.request(e.id, confirm.action, confirm.action === 'extend' ? { minutes: Number(minutes) } : undefined);
      else if (confirm.kind === 'approve') r = await staff.approve(confirm.id); else if (confirm.kind === 'freeze') r = await staff.freeze(e.id); else r = await staff.ratifyFreeze(e.id);
      if (!r.ok) return fail(r);
      say('ok', confirm.kind === 'request' ? 'Request sent. A different administrator has to approve it.' : confirm.kind === 'approve' ? `Done: ${label(confirm.action)}.` : confirm.kind === 'freeze' ? 'Voting is frozen. It lifts itself in 15 minutes unless a different administrator confirms.' : 'Freeze confirmed.');
      setConfirm(null); bump();
    } finally { setBusy(false); }
  }
  async function cancel(p: Pending) { const r = await staff.cancel(p.id); if (!r.ok) return fail(r); say('ok', p.mine ? 'Your request was withdrawn.' : 'The request was declined.'); bump(); }
  const what = !confirm ? null : confirm.kind === 'freeze' ? { t: 'Freeze voting now', effect: 'All voting stops immediately. It lifts itself after 15 minutes unless a different administrator confirms it.' } : confirm.kind === 'ratify' ? { t: 'Confirm the freeze', effect: 'Keeps voting frozen. A different administrator from the one who froze it must do this.' } : { t: label(confirm.action), effect: INFO[confirm.action].effect };
  return <Section id="controls" eyebrow="02 · Approvals and controls" title="Sensitive actions need two people"><Card>
    <p style={{ color: 'var(--muted)', fontSize: 13 }}>One administrator requests; a different administrator approves from their own sign-in.</p>
    <h3 style={{ margin: '0 0 8px' }}>Waiting for approval</h3>
    {!q?.pending.length ? <p>Nothing is waiting.</p> : <ul className="plain-list">{q.pending.map((p) => <li key={p.id} style={{ margin: '10px 0' }}><strong>{label(p.action, p.params)}</strong> · requested by {p.initiator}{p.mine ? ' (you)' : ''}, {formatWhen(p.createdAt)}
      <div className="control-row">{p.mine ? <span>Waiting for another administrator.</span> : <Button onClick={() => setConfirm({ kind: 'approve', id: p.id, action: p.action as ActionName })}>Approve<span className="sr-only"> {label(p.action, p.params)}</span></Button>}
        <Button variant="quiet" onClick={() => void cancel(p)}>{p.mine ? 'Withdraw' : 'Decline'}<span className="sr-only"> {label(p.action, p.params)}</span></Button></div></li>)}</ul>}
    <h3 style={{ margin: '18px 0 8px' }}>Request an action</h3>
    <div className="control-row">{available.length ? available.map((a) => <Button key={a} variant="secondary" onClick={() => setConfirm({ kind: 'request', action: a })}>Request: {INFO[a].label}</Button>) : <span>No action is available in this state.</span>}
      {s === 'OPEN' && !e.frozen && <Button variant="danger" onClick={() => setConfirm({ kind: 'freeze' })}>Freeze voting now</Button>}{e.frozen && !e.freezeConfirmed && !e.freezeByMe && <Button variant="danger" onClick={() => setConfirm({ kind: 'ratify' })}>Confirm the freeze</Button>}</div>
    {e.frozen && <p role="note">{e.freezeConfirmed ? 'The freeze was confirmed by a second administrator. It stays until it is lifted below.' : e.freezeByMe ? 'You froze voting. A different administrator must confirm, or it lifts itself 15 minutes after it started.' : 'Another administrator froze voting. Confirm it if you agree, or it lifts itself 15 minutes after it started.'}</p>}
    {confirm && what && <div role="group" aria-label={`Confirm: ${what.t}`} className="card" style={{ marginTop: 14, boxShadow: 'none' }}>
      <strong>{what.t}</strong><p style={{ margin: '6px 0' }}>{what.effect}</p>
      {confirm.kind === 'request' && confirm.action === 'extend' && <div className="field"><label htmlFor="minutes">Minutes to add (1 to 1,440)</label><input id="minutes" type="number" min={1} max={1440} value={minutes} onChange={(ev) => setMinutes(ev.target.value)} /></div>}
      <div className="control-row"><Button disabled={busy} onClick={() => void go()}>{confirm.kind === 'approve' ? 'Approve' : confirm.kind === 'request' ? 'Send request' : 'Yes, do it'}</Button><Button variant="quiet" onClick={() => setConfirm(null)}>Cancel</Button></div></div>}
    <h3 style={{ margin: '18px 0 8px' }}>Recently done</h3>
    {!q?.recent.length ? <p>Nothing yet.</p> : <ul className="plain-list">{q.recent.map((d, i) => <li key={i}>{label(d.action, d.params)}: requested by {d.initiator}, approved by {d.approver}, {formatWhen(d.at)}</li>)}</ul>}
  </Card></Section>;
}

const KIND = { protest: 'Protest', dispute: 'Account dispute', report: 'Fake-site report' } as const;
function SupportItem({ row, onSaved }: { row: SupportRow; onSaved: () => void }) {
  const { fail, say } = useContext(Ctx); const [status, setStatus] = useState(row.status); const [note, setNote] = useState(row.note ?? '');
  async function save(event: FormEvent) { event.preventDefault(); const r = await staff.setSupportStatus(row.id, status, note); if (!r.ok) return fail(r); say('ok', `${row.ref} saved.`); onSaved(); }
  return <li className="card" style={{ margin: '12px 0', boxShadow: 'none' }}>
    <div className="control-row"><strong>{row.ref}</strong><StatusPill>{KIND[row.kind]}</StatusPill><span style={{ color: 'var(--muted)', fontSize: 12 }}>{formatWhen(row.created_at)}</span></div>
    {row.student_id && <p style={{ margin: '6px 0' }}>Student ID <strong>{row.student_id}</strong> · {row.on_roll ? 'on the roll' : 'not on the roll'} · {row.session_verified ? 'signed in as this student' : 'not verified'}</p>}
    {row.subject && <p style={{ margin: '6px 0' }}><strong>{row.subject}</strong></p>}
    {row.details && <p style={{ margin: '6px 0', whiteSpace: 'pre-wrap' }}>{row.details}</p>}
    {row.url && <p style={{ margin: '6px 0' }}>Reported address (do not open): <code>{row.url}</code></p>}
    <form onSubmit={(ev) => void save(ev)} className="control-row" style={{ alignItems: 'end' }}>
      <div className="field"><label htmlFor={`st-${row.id}`}>Status of {row.ref}</label><select id={`st-${row.id}`} value={status} onChange={(ev) => setStatus(ev.target.value)}><option value="NEW">New</option><option value="IN_REVIEW">In review</option><option value="RESOLVED">Resolved</option><option value="DISMISSED">Dismissed</option></select></div>
      <div className="field"><label htmlFor={`nt-${row.id}`}>Note for {row.ref}</label><input id={`nt-${row.id}`} value={note} maxLength={2000} onChange={(ev) => setNote(ev.target.value)} /></div>
      <Button type="submit" variant="secondary" disabled={status === row.status && note === (row.note ?? '')}>Save<span className="sr-only"> {row.ref}</span></Button></form></li>;
}
function Support() {
  const { election: e, tick, fail } = useContext(Ctx); const [rows, setRows] = useState<SupportRow[] | null>(null); const [status, setStatus] = useState(''); const [kind, setKind] = useState('');
  const [sid, setSid] = useState(''); const [code, setCode] = useState<{ studentId: string; claimCode: string; validDays: number } | null>(null); const [codeErr, setCodeErr] = useState(''); const [reload, setReload] = useState(0);
  useEffect(() => { let on = true; void staff.support(e.id, status, kind).then((r) => { if (!on) return; r.ok ? setRows(r.data.requests) : fail(r); }); return () => { on = false; }; }, [e.id, tick, status, kind, reload, fail]);
  useEffect(() => { setCode(null); }, [e.id]);
  async function issue(event: FormEvent) { event.preventDefault(); setCodeErr(''); setCode(null); const r = await staff.issueClaimCode(e.id, sid.trim()); if (r.ok) { setCode(r.data); setSid(''); } else if (r.code === 'SESSION_ENDED') fail(r); else setCodeErr(r.code === 'NOT_FOUND' || r.code === 'GATE_NOT_FOUND' ? 'No online voter with that Student ID can be given a claim code in this election.' : r.message); }
  return <Section id="support" eyebrow="03 · Support requests" title="Protests, disputes and reports"><Card>
    <div className="control-row"><div className="field"><label htmlFor="f-status">Show status</label><select id="f-status" value={status} onChange={(ev) => setStatus(ev.target.value)}><option value="">All</option><option value="NEW">New</option><option value="IN_REVIEW">In review</option><option value="RESOLVED">Resolved</option><option value="DISMISSED">Dismissed</option></select></div>
      <div className="field"><label htmlFor="f-kind">Show kind</label><select id="f-kind" value={kind} onChange={(ev) => setKind(ev.target.value)}><option value="">All</option><option value="protest">Protests</option><option value="dispute">Account disputes</option><option value="report">Fake-site reports</option></select></div></div>
    {!rows ? <p>Loading…</p> : !rows.length ? <p>No requests match.</p> : <ul className="plain-list" aria-label="Support requests">{rows.map((r) => <SupportItem key={`${r.id}-${r.status}-${r.note ?? ''}`} row={r} onSaved={() => setReload((n) => n + 1)} />)}</ul>}
    <h3 style={{ margin: '18px 0 8px' }}>Give a student an in-person claim code</h3>
    <p style={{ color: 'var(--muted)', fontSize: 13 }}>Check the student’s school ID first. Issuing a code also blocks password reset on that account until the code is used, so whoever holds it now cannot reset it.</p>
    <form onSubmit={(ev) => void issue(ev)} className="control-row" style={{ alignItems: 'end' }}><div className="field"><label htmlFor="claim-student">Student ID</label><input id="claim-student" value={sid} onChange={(ev) => setSid(ev.target.value)} maxLength={32} required /></div><Button type="submit" variant="secondary">Issue claim code</Button></form>
    {codeErr && <div className="form-message" role="alert">{codeErr}</div>}
    {code && <div className="form-message" role="status"><p style={{ margin: 0 }}>Claim code for {code.studentId}: <strong style={{ fontSize: 22, letterSpacing: 2 }}>{code.claimCode}</strong></p><p style={{ margin: '6px 0' }}>It is shown only once and is valid for {code.validDays} days. Give it to the student in person.</p><Button variant="quiet" onClick={() => setCode(null)}>Done, hide it</Button></div>}
  </Card></Section>;
}

function Results() {
  const { election: e, tick, bump, fail, say } = useContext(Ctx); const [st, setSt] = useState<ResultsStatus | null>(null); const [file, setFile] = useState<{ name: string; results: { body: string; signature: string }; chain: string; ballots: number } | null>(null); const [fileErr, setFileErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { let on = true; void staff.resultsStatus(e.id).then((r) => { if (!on) return; r.ok ? setSt(r.data) : fail(r); }); return () => { on = false; }; }, [e.id, tick, fail]);
  async function pick(files: FileList | null) {
    setFile(null); setFileErr(''); const f = files?.[0]; if (!f) return;
    try { const j = JSON.parse(await f.text()) as { body?: unknown; signature?: unknown }; if (typeof j.body !== 'string' || typeof j.signature !== 'string') throw new Error(); const b = JSON.parse(j.body) as { chain?: unknown; ballots?: unknown };
      if (typeof b.chain !== 'string' || typeof b.ballots !== 'number') throw new Error(); setFile({ name: f.name, results: { body: j.body, signature: j.signature }, chain: b.chain, ballots: b.ballots });
    } catch { setFileErr('That is not a results file from the tally tool. Choose the results.json that `ev tally` wrote.'); }
  }
  async function importIt() { if (!file) return; setBusy(true); try { const r = await staff.importResults(e.id, file.results); if (!r.ok) return fail(r); say('ok', `Tally for chain ${r.data.chain} imported (${r.data.ballots} ballots).`); setFile(null); bump(); } finally { setBusy(false); } }
  const hint = !st ? '' : e.status === 'TALLIED' ? (st.certifyBlocker ? `Not ready to certify: ${explain('GATE_' + st.certifyBlocker)}` : 'Ready to certify. Request certification under Approvals and controls.') : e.status === 'CLOSED' ? 'Voting is closed. Seal the ballots, run the tally tool, then import its signed result here.' : e.status === 'CERTIFIED' ? 'Certified. The counts are public.' : 'Results can be imported after voting closes.';
  return <Section id="results" eyebrow="04 · Results" title="Signed tally and certification"><Card>
    <p>{hint}</p>
    {st && <table className="results-table"><caption className="sr-only">Ballot chains and their imported tallies</caption><thead><tr><th scope="col">Chain</th><th scope="col" className="num">Ballots</th><th scope="col">Tally</th></tr></thead>
      <tbody>{st.chains.length ? st.chains.map((c) => <tr key={c.chain}><th scope="row">{c.chain}</th><td className="num">{c.ballots.toLocaleString()}</td><td>{c.imported ? (c.matches ? 'Imported, matches the chain' : 'Imported, does NOT match') : 'Not imported yet'}</td></tr>) : <tr><td colSpan={3}>No ballots in any chain yet.</td></tr>}</tbody></table>}
    {st && <p style={{ color: 'var(--muted)', fontSize: 12 }}>{st.inbox.toLocaleString()} ballots waiting to be sealed · {st.participation.toLocaleString()} people recorded as voted</p>}
    {(e.status === 'CLOSED' || e.status === 'TALLIED') && <><h3 style={{ margin: '14px 0 8px' }}>Import a signed tally</h3>
      <div className="field"><label htmlFor="results-file">Results file (results.json)</label><input id="results-file" type="file" accept=".json,application/json" onChange={(ev) => void pick(ev.target.files)} /><small>One file per chain. The server checks the signature and compares the tally with the sealed ballots before accepting it.</small></div>
      {fileErr && <div className="form-message" role="alert">{fileErr}</div>}
      {file && <p>Ready to import <strong>{file.name}</strong>: chain <strong>{file.chain}</strong>, {file.ballots.toLocaleString()} ballots.</p>}
      <Button disabled={!file || busy} onClick={() => void importIt()}>Import tally</Button></>}
    {e.status === 'CERTIFIED' && <p><Link to="/results">See the public results page</Link></p>}
  </Card></Section>;
}

// ---------------------------------------------------------------- your own account
function Account({ me }: { me: StaffMe }) {
  const { fail, refresh } = useContext(Tools);
  const [pw, setPw] = useState<{ ok: boolean; text: string } | null>(null), [auth, setAuth] = useState<{ ok: boolean; text: string } | null>(null), [rec, setRec] = useState<{ ok: boolean; text: string } | null>(null);
  const [enroll, setEnroll] = useState<{ secret: string; uri: string } | null>(null), [codes, setCodes] = useState<string[] | null>(null);
  const field = (f: FormData, n: string) => String(f.get(n) || '');
  async function changePassword(ev: FormEvent<HTMLFormElement>) { ev.preventDefault(); const f = new FormData(ev.currentTarget), form = ev.currentTarget;
    if (field(f, 'next') !== field(f, 'confirm')) return setPw({ ok: false, text: 'The two new passwords do not match.' });
    const r = await staff.changePassword(field(f, 'current'), field(f, 'next')); if (r.ok) { setPw({ ok: true, text: 'Password changed. Any other place you were signed in has been signed out.' }); form.reset(); } else if (r.code === 'SESSION_ENDED') fail(r); else setPw({ ok: false, text: r.message }); }
  async function startAuth(ev: FormEvent<HTMLFormElement>) { ev.preventDefault(); const f = new FormData(ev.currentTarget);
    const r = await staff.startAuthenticator(field(f, 'password')); if (r.ok) { setEnroll(r.data); setAuth(null); } else if (r.code === 'SESSION_ENDED') fail(r); else setAuth({ ok: false, text: r.message }); }
  async function confirmAuth(ev: FormEvent<HTMLFormElement>) { ev.preventDefault(); const f = new FormData(ev.currentTarget);
    const r = await staff.confirmAuthenticator(field(f, 'code')); if (r.ok) { setEnroll(null); setAuth({ ok: true, text: 'Your authenticator was replaced. Any other place you were signed in has been signed out. Use the new one from now on.' }); void refresh(); } else if (r.code === 'SESSION_ENDED') fail(r); else setAuth({ ok: false, text: r.message }); }
  async function newCodes(ev: FormEvent<HTMLFormElement>) { ev.preventDefault(); const f = new FormData(ev.currentTarget), form = ev.currentTarget;
    const r = await staff.newRecoveryCodes(field(f, 'password')); if (r.ok) { setCodes(r.data.recoveryCodes); setRec(null); form.reset(); void refresh(); } else if (r.code === 'SESSION_ENDED') fail(r); else setRec({ ok: false, text: r.message }); }
  const msg = (m: { ok: boolean; text: string } | null) => m && <div className="form-message" role={m.ok ? 'status' : 'alert'}>{m.text}</div>;
  return <Section id="account" eyebrow="Your account" title={`Sign-in security for ${me.name}`}><Card>
    <p style={{ color: 'var(--muted)', fontSize: 13 }}>Username <strong>{me.username}</strong> · {me.recoveryCodesLeft} unused recovery code{me.recoveryCodesLeft === 1 ? '' : 's'}{me.recoveryCodesLeft < 3 ? '. Make a new set soon.' : ''}</p>
    <h3 style={{ margin: '12px 0 8px' }}>Change your password</h3>
    <form onSubmit={(ev) => void changePassword(ev)}>
      <div className="field"><label htmlFor="pw-current">Current password</label><input id="pw-current" name="current" type="password" autoComplete="current-password" required /></div>
      <div className="field"><label htmlFor="pw-next">New password (at least 12 characters)</label><input id="pw-next" name="next" type="password" autoComplete="new-password" minLength={12} required /></div>
      <div className="field"><label htmlFor="pw-confirm">Confirm new password</label><input id="pw-confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} required /></div>
      {msg(pw)}<Button type="submit" variant="secondary">Change password</Button></form>
    <h3 style={{ margin: '20px 0 8px' }}>Replace your authenticator</h3>
    <p style={{ fontSize: 13 }}>Use this when you get a new phone. The old authenticator keeps working until the new one proves itself.</p>
    {!enroll ? <form onSubmit={(ev) => void startAuth(ev)}><div className="field"><label htmlFor="auth-password">Your password</label><input id="auth-password" name="password" type="password" autoComplete="current-password" required /></div>{msg(auth)}<Button type="submit" variant="secondary">Start replacing</Button></form>
      : <form onSubmit={(ev) => void confirmAuth(ev)}><p style={{ fontSize: 13 }}>In your authenticator app choose “enter a setup key”, or <a href={enroll.uri}>open it in the app</a>.</p><p><code aria-label="New authenticator setup key" style={{ fontSize: 18, letterSpacing: 1, wordBreak: 'break-all' }}>{groups(enroll.secret)}</code></p>
        <div className="field"><label htmlFor="auth-code">6-digit code from the new entry</label><input id="auth-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></div>{msg(auth)}
        <div className="control-row"><Button type="submit">Confirm new authenticator</Button><Button type="button" variant="quiet" onClick={() => setEnroll(null)}>Cancel</Button></div></form>}
    <h3 style={{ margin: '20px 0 8px' }}>Recovery codes</h3>
    <p style={{ fontSize: 13 }}>Each code signs you in once if you lose your phone. Making a new set cancels the old codes.</p>
    <form onSubmit={(ev) => void newCodes(ev)}><div className="field"><label htmlFor="rec-password">Your password</label><input id="rec-password" name="password" type="password" autoComplete="current-password" required /></div>{msg(rec)}<Button type="submit" variant="secondary">Make new recovery codes</Button></form>
    {codes && <div className="form-message" role="status"><p style={{ margin: 0 }}>Your new recovery codes. They are shown only now.</p><ul className="plain-list recovery" aria-label="New recovery codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul><Button variant="quiet" onClick={() => setCodes(null)}>Done, hide them</Button></div>}
  </Card></Section>;
}

// ---------------------------------------------------------------- people (administrators)
const ROLE: Record<string, string> = { ADMIN: 'Administrator', PROCTOR: 'Proctor', OBSERVER: 'Observer' };
const PSTATUS: Record<string, string> = { INVITED: 'Waiting for setup', ACTIVE: 'Active', DISABLED: 'Disabled' };
const REQ_LABEL = (r: PersonRequest) => r.action === 'invite' ? `Add administrator ${r.target}` : r.action === 'disable' ? `Disable ${r.target}` : `Reset sign-in for ${r.target}`;
function People() {
  const { fail, say } = useContext(Tools); const [data, setData] = useState<{ staff: Person[]; pending: PersonRequest[] } | null>(null); const [reload, setReload] = useState(0);
  const [reveal, setReveal] = useState<{ username: string; setupCode: string; validDays: number; action: string } | null>(null); const [confirm, setConfirm] = useState<{ kind: 'disable' | 'reinvite'; p: Person } | null>(null);
  const [role, setRole] = useState('PROCTOR'); const [formErr, setFormErr] = useState('');
  useEffect(() => { let on = true; void staff.people().then((r) => { if (!on) return; r.ok ? setData(r.data) : fail(r); }); return () => { on = false; }; }, [reload, fail]);
  const done = (r: Call<Revealed>, ok: string) => { if (!r.ok) { fail(r); return false; } const v = r.data;
    if (v.pending) say('ok', 'Request sent. A different administrator has to approve it.'); else if (v.setupCode) { setReveal({ username: v.username, setupCode: v.setupCode, validDays: v.validDays ?? 3, action: v.action }); say('ok', ok); } else say('ok', ok);
    setReload((n) => n + 1); return true; };
  async function invite(ev: FormEvent<HTMLFormElement>) { ev.preventDefault(); setFormErr(''); const f = new FormData(ev.currentTarget), form = ev.currentTarget;
    const r = await staff.invite(String(f.get('name') || '').trim(), String(f.get('username') || '').trim(), role); if (!r.ok && r.code !== 'SESSION_ENDED') setFormErr(r.message); else if (done(r, 'Invitation created.')) form.reset(); }
  async function go() { if (!confirm) return; const r = confirm.kind === 'disable' ? await staff.disable(confirm.p.id) : await staff.reinvite(confirm.p.id); if (!r.ok && r.code !== 'SESSION_ENDED') say('err', r.message); else done(r, confirm.kind === 'disable' ? `${confirm.p.name} was disabled and signed out.` : `${confirm.p.name}'s sign-in was reset.`); setConfirm(null); }
  async function approve(p: PersonRequest) { const r = await staff.approvePerson(p.id); if (!r.ok && r.code !== 'SESSION_ENDED') say('err', r.message); else done(r, 'Approved.'); }
  async function cancel(p: PersonRequest) { const r = await staff.cancelPerson(p.id); if (!r.ok) return fail(r); say('ok', p.mine ? 'Your request was withdrawn.' : 'The request was declined.'); setReload((n) => n + 1); }
  return <Section id="people" eyebrow="05 · People" title="Who can run this election"><Card>
    <p style={{ color: 'var(--muted)', fontSize: 13 }}>Adding an administrator, or disabling or resetting one, needs a different administrator to approve. Proctors and observers can be handled by one administrator.</p>
    {data && <table className="results-table"><caption className="sr-only">Staff accounts</caption><thead><tr><th scope="col">Name</th><th scope="col">Username</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
      <tbody>{data.staff.map((p) => <tr key={p.id}><th scope="row">{p.name}{p.me ? ' (you)' : ''}</th><td>{p.username}</td><td>{ROLE[p.role] ?? p.role}</td><td>{PSTATUS[p.status] ?? p.status}</td>
        <td>{p.me ? '' : <div className="control-row">{p.status !== 'DISABLED' && <Button variant="quiet" onClick={() => setConfirm({ kind: 'disable', p })}>Disable<span className="sr-only"> {p.name}</span></Button>}<Button variant="quiet" onClick={() => setConfirm({ kind: 'reinvite', p })}>Reset sign-in<span className="sr-only"> for {p.name}</span></Button></div>}</td></tr>)}</tbody></table>}
    {confirm && <div role="group" aria-label={`Confirm: ${confirm.kind === 'disable' ? 'disable' : 'reset sign-in for'} ${confirm.p.name}`} className="card" style={{ marginTop: 14, boxShadow: 'none' }}>
      <strong>{confirm.kind === 'disable' ? `Disable ${confirm.p.name}` : `Reset sign-in for ${confirm.p.name}`}</strong>
      <p style={{ margin: '6px 0' }}>{confirm.kind === 'disable' ? 'They are signed out at once and cannot sign in again.' : 'Their password, authenticator and recovery codes are removed, and they set up again with a new one-time code.'}{confirm.p.role === 'ADMIN' ? ' Because they are an administrator, a different administrator has to approve this.' : ''}</p>
      <div className="control-row"><Button onClick={() => void go()}>{confirm.p.role === 'ADMIN' ? 'Send request' : 'Yes, do it'}</Button><Button variant="quiet" onClick={() => setConfirm(null)}>Cancel</Button></div></div>}
    <h3 style={{ margin: '18px 0 8px' }}>Waiting for approval</h3>
    {!data?.pending.length ? <p>Nothing is waiting.</p> : <ul className="plain-list">{data.pending.map((r) => <li key={r.id} style={{ margin: '10px 0' }}><strong>{REQ_LABEL(r)}</strong> · requested by {r.initiator}{r.mine ? ' (you)' : ''}
      <div className="control-row">{r.mine ? <span>Waiting for another administrator.</span> : <Button onClick={() => void approve(r)}>Approve<span className="sr-only"> {REQ_LABEL(r)}</span></Button>}<Button variant="quiet" onClick={() => void cancel(r)}>{r.mine ? 'Withdraw' : 'Decline'}<span className="sr-only"> {REQ_LABEL(r)}</span></Button></div></li>)}</ul>}
    <h3 style={{ margin: '18px 0 8px' }}>Invite someone</h3>
    <form onSubmit={(ev) => void invite(ev)} className="control-row" style={{ alignItems: 'end' }}>
      <div className="field"><label htmlFor="inv-name">Full name</label><input id="inv-name" name="name" maxLength={80} required /></div>
      <div className="field"><label htmlFor="inv-username">Username</label><input id="inv-username" name="username" maxLength={32} autoCapitalize="none" required /></div>
      <div className="field"><label htmlFor="inv-role">Role</label><select id="inv-role" value={role} onChange={(e) => setRole(e.target.value)}><option value="PROCTOR">Proctor</option><option value="OBSERVER">Observer</option><option value="ADMIN">Administrator (needs approval)</option></select></div>
      <Button type="submit" variant="secondary">Invite</Button></form>
    {formErr && <div className="form-message" role="alert">{formErr}</div>}
    {reveal && <div className="form-message" role="status"><p style={{ margin: 0 }}>Setup code for {reveal.username}: <strong style={{ fontSize: 22, letterSpacing: 2 }}>{reveal.setupCode}</strong></p><p style={{ margin: '6px 0' }}>It is shown only once and works once, for {reveal.validDays} days. Give it to them in person. They open <strong>/staff/setup</strong> to choose their own password and connect their authenticator.</p><Button variant="quiet" onClick={() => setReveal(null)}>Done, hide it</Button></div>}
  </Card></Section>;
}
