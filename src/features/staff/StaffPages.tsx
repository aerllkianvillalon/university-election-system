// Staff console (live server only): sign-in with authenticator code, then the operate-and-oversee screens for an election's administrators.
// Two-person rule: a request is made by one administrator and approved by a DIFFERENT one from their own session. Nothing here can approve your own request.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, LogOut } from 'lucide-react';
import { qrSvg } from '../../lib/qr';
import { ActionLink, Button, Card, Eyebrow, StatCard, StatusPill } from '../../components/ui/Primitives';
import { formatWhen } from '../../lib/api/client';
import { ACTIONS, explain, staff, type ActionName, type AuditCheck, type AuditEntry, type Call, type Done, type Pending, type Person, type PersonRequest, type Readiness, type SetupOverview, type Scope, type ResultsStatus, type Revealed, type StaffElection, type StaffMe, type SupportRow, type Turnout } from '../../lib/api/staff';


// ---------------------------------------------------------------- small helpers
// Opt-in only: on a shared computer the next person must not see who signed in last.
const remembered = { get: () => { try { return localStorage.getItem('staff-username') || ''; } catch { return ''; } }, set: (v: string, keep: boolean) => { try { if (keep && v) localStorage.setItem('staff-username', v); else localStorage.removeItem('staff-username'); } catch { /* optional */ } } };
async function copy(text: string) { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } }
// Copy and download for things that are shown only once (codes). Says what happened, so nobody wonders if it worked.
function CopyTools({ text, file }: { text: string; file?: string }) {
  const [done, setDone] = useState('');
  function save() { const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = file || 'codes.txt'; a.click(); URL.revokeObjectURL(url); setDone('Saved as a file.'); }
  return <span className="control-row" style={{ display: 'inline-flex' }}><Button variant="secondary" onClick={() => void copy(text).then((ok) => setDone(ok ? 'Copied.' : 'Could not copy. Select the text and copy it by hand.'))}>Copy</Button>{file && <Button variant="secondary" onClick={save}>Save as a file</Button>}{done && <span role="status">{done}</span>}</span>;
}
// A 6-digit code box: accepts "123 456" pasted from the app, keeps only digits, and (optionally) sends the form by itself on the sixth digit.
function CodeInput({ id, name = 'code', label, hint, autoSubmit, autoFocus }: { id: string; name?: string; label: string; hint?: string; autoSubmit?: boolean; autoFocus?: boolean }) {
  return <div className="field"><label htmlFor={id}>{label}</label><input id={id} name={name} inputMode="numeric" autoComplete="one-time-code" autoFocus={autoFocus} maxLength={9} required placeholder="000000"
    onChange={(e) => { const d = e.currentTarget.value.replace(/\D/g, '').slice(0, 6); e.currentTarget.value = d; if (autoSubmit && d.length === 6) e.currentTarget.form?.requestSubmit(); }} />{hint && <small>{hint}</small>}</div>;
}

// ---------------------------------------------------------------- sign in
function LoginForm() {
  const nav = useNavigate(); const [params] = useSearchParams();
  const [step, setStep] = useState<'password' | 'code'>('password'); const [recovery, setRecovery] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [show, setShow] = useState(false); const saved = remembered.get();
  useEffect(() => { void staff.me().then((r) => { if (r.ok) nav('/staff', { replace: true }); }); }, [nav]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setError(''); setBusy(true); const form = new FormData(event.currentTarget);
    try {
      if (step === 'password') {
        const r = await staff.login(String(form.get('username') || '').trim(), String(form.get('password') || ''));
        if (r === 'mfa') { remembered.set(String(form.get('username') || '').trim(), form.get('remember') === 'on'); setStep('code'); } else setError(r === 'limited' ? 'Too many attempts. Wait a few minutes and try again.' : r === 'network' ? 'Cannot reach the server.' : 'Check your username and password.');
      } else {
        const r = recovery ? await staff.mfaRecovery(String(form.get('recovery') || '').trim()) : await staff.mfa(String(form.get('code') || '').trim());
        if (r === 'ok') nav('/staff', { replace: true }); else setError(r === 'limited' ? 'Too many attempts. Wait a few minutes and start again.' : recovery ? 'That recovery code did not work. Each code works once. Check it, or start over.' : 'That code did not work. Check the 6-digit code in your authenticator app, use a recovery code, or start over.');
      }
    } finally { setBusy(false); }
  }
  return <><div className="page-head"><div><Eyebrow>Staff</Eyebrow><h1>Staff <span className="highlight-word">sign-in.</span></h1><p>Enter your username and password, then the 6-digit code from your authenticator app.</p></div></div>
    <Card className="form-card" style={{ maxWidth: 460 }}>
      {params.get('ended') && <div className="form-message" role="status">You were signed out after a few minutes without activity. Sign in again. Nothing you finished was lost.</div>}
      <form noValidate onSubmit={submit} key={step}>
        {step === 'password' ? <>
          <div className="field"><label htmlFor="username">Username</label><input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} defaultValue={saved} autoFocus={!saved} required /></div>
          <div className="field"><label htmlFor="password">Password</label><div className="pw-wrap"><input id="password" name="password" type={show ? 'text' : 'password'} autoComplete="current-password" autoFocus={!!saved} required />
            <button type="button" className="pw-eye" aria-label={show ? 'Hide what I type' : 'Show what I type'} aria-pressed={show} onClick={() => setShow((v) => !v)}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></div>
          <label className="checkline"><input type="checkbox" name="remember" defaultChecked={!!saved} /> <span>Remember me on this device. Leave this off on a shared computer.</span></label></> :
          (recovery ? <div className="field"><label htmlFor="recovery">Recovery code</label><input id="recovery" name="recovery" autoComplete="off" autoFocus spellCheck={false} maxLength={24} required /><small>One of the codes you saved when you set up your account. Each works once.</small></div>
            : <CodeInput id="code" label="6-digit code" autoFocus autoSubmit hint="From your authenticator app. You can paste it. It signs you in as soon as the sixth digit is in. Each code works once." />)}
        {error && <div className="form-message" role="alert">{error}</div>}
        <Button className="btn-block form-submit" type="submit" disabled={busy}>{busy ? 'Please wait…' : step === 'password' ? 'Continue' : 'Sign in'}</Button>
        <div className="form-links">
        {step === 'code' && <p><button type="button" className="link-button" onClick={() => { setRecovery((r) => !r); setError(''); }}>{recovery ? 'Use my authenticator app instead' : 'Lost your phone? Use a recovery code'}</button></p>}
        {step === 'code' && <p><button type="button" className="link-button" onClick={() => { setStep('password'); setRecovery(false); setError(''); }}>Start over</button></p>}
        {step === 'password' && <p style={{ fontSize: 13, color: 'var(--muted)' }}>First time here? <Link to="/staff/setup">Set up your account</Link> with the one-time code you were given. Forgot your password? Ask an administrator to reset it.</p>}
        </div>
      </form></Card></>;
}
export const StaffLogin = () => <LoginForm />;

// ---------------------------------------------------------------- first-time setup with a one-time code
function QrBox({ uri }: { uri: string }) {
  let svg = ''; try { svg = qrSvg(uri); } catch { /* the typed key below still works */ }
  return svg ? <div className="qr-box" dangerouslySetInnerHTML={{ __html: svg }} /> : null;   // the SVG is generated here from numbers only
}
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
        <div className="field"><label htmlFor="username">Username</label><input id="username" name="username" autoComplete="username" autoCapitalize="none" autoFocus required /></div>
        <div className="field"><label htmlFor="setup-code">Setup code</label><input id="setup-code" name="setupCode" autoComplete="off" required /><small>Looks like ABCD-EFGH-JKMN. It works once.</small></div>
        {error && <div className="form-message" role="alert">{error}</div>}<Button className="btn-block" type="submit" disabled={busy}>{busy ? 'Please wait…' : 'Continue'}</Button></form>}
      {step === 'enroll' && info && <form noValidate onSubmit={submit}>
        <p>Welcome, <strong>{info.name}</strong>. Two things to do: connect your authenticator app, then choose a password.</p>
        <h2 style={{ ...h2, fontSize: 16 }}>1. Connect your authenticator app</h2>
        <div className="qr-help"><QrBox uri={info.uri} /><p><strong>On a computer:</strong> open your authenticator app, choose “scan a QR code” and scan this picture.<br /><strong>On your phone:</strong> <a href={info.uri}>open it in your authenticator app</a>, or choose “enter a setup key” and type the key below.</p></div>
        <p><code aria-label="Authenticator setup key" style={{ fontSize: 18, letterSpacing: 1, wordBreak: 'break-all' }}>{groups(info.secret)}</code></p>
        <h2 style={{ ...h2, fontSize: 16 }}>2. Choose your password</h2>
        <div className="field"><label htmlFor="password">Password (at least 12 characters)</label><input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required /></div>
        <div className="field"><label htmlFor="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} required /></div>
        <h2 style={{ ...h2, fontSize: 16 }}>3. Prove it works</h2>
        <CodeInput id="code" label="6-digit code from the app" hint="Wait for the app to show the code for this account, then type or paste it." />
        {error && <div className="form-message" role="alert">{error}</div>}<Button className="btn-block" type="submit" disabled={busy}>{busy ? 'Please wait…' : 'Finish setup'}</Button></form>}
      {step === 'done' && <div><div className="form-message" role="status">Your account is ready.</div>
        <h2 style={{ ...h2, fontSize: 16 }}>Save your recovery codes</h2><p style={{ fontSize: 13 }}>If you lose your phone, each of these lets you sign in once. They are shown only now. Keep them somewhere safe and separate from your phone.</p>
        <ul className="plain-list recovery" aria-label="Recovery codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
        <CopyTools text={codes.join('\n')} file="recovery-codes.txt" />
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
const TABS: [string, string][] = [['summary', 'Overview'], ['setup', 'Set up election'], ['controls', 'Approvals'], ['support', 'Support requests'], ['results', 'Results'], ['people', 'People'], ['audit', 'Activity log'], ['account', 'My account']];
const tabFromHash = () => { const h = window.location.hash.replace('#', ''); return TABS.some(([id]) => id === h) ? h : 'summary'; };
const NEXT: Record<string, string> = { DRAFT: 'finish the readiness checks below, then request "Lock the election".', CONFIGURED: 'finish the readiness checks below, then request "Lock the election".', LOCKED: 'when the times are right, request "Open voting". A different administrator approves it.', OPEN: 'watch turnout. Answer support requests. Voting closes by itself at the closing time.', CLOSED: 'run the offline seal and tally steps, then import the signed results.', TALLIED: 'check the results, then request "Certify the results".', CERTIFIED: 'nothing. The results are public.' };
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

// Warns before the 15-minute session ends and lets the person extend it (the server caps a session at 8 hours in total).
function SessionGuard({ onEnded }: { onEnded: () => void }) {
  const [left, setLeft] = useState<number | null>(null); const [msg, setMsg] = useState('');
  const endAt = useRef<number | null>(null); const lastActive = useRef(Date.now()); const extending = useRef(false); const lastAuto = useRef(0);
  const sync = useCallback(async () => { const r = await staff.session(); if (!r.ok) { if (r.code === 'SESSION_ENDED') onEnded(); return; } if (r.data.expiresAt) endAt.current = new Date(r.data.expiresAt).getTime(); else onEnded(); }, [onEnded]);
  useEffect(() => { void sync(); const t = window.setInterval(() => { if (endAt.current === null) return; const s = Math.round((endAt.current - Date.now()) / 1000); setLeft(s); if (s <= 0) onEnded(); }, 1000); const c = window.setInterval(() => { if (endAt.current && endAt.current - Date.now() > 130_000) void sync(); }, 60_000); return () => { window.clearInterval(t); window.clearInterval(c); }; }, [sync, onEnded]);
  async function more() { if (extending.current) return; extending.current = true; setMsg(''); try { await extendNow(); } finally { extending.current = false; } }
  async function extendNow() { const r = await staff.extendSession(); if (r.ok) { endAt.current = new Date(r.data.expiresAt).getTime(); setLeft(Math.round((endAt.current - Date.now()) / 1000)); } else if (r.code === 'SESSION_ENDED') onEnded(); else setMsg('Could not extend. Save what you are doing, then sign in again.'); }
  // Someone who is working should never be interrupted: with 4 minutes or less left, any click or key press in the last 2 minutes quietly adds 15 minutes (the server stops this at 8 hours in total).
  useEffect(() => { const mark = () => { lastActive.current = Date.now(); }; const ev = ['pointerdown', 'keydown', 'scroll'] as const; ev.forEach((n) => window.addEventListener(n, mark, { passive: true })); return () => ev.forEach((n) => window.removeEventListener(n, mark)); }, []);
  useEffect(() => { if (left !== null && left > 0 && left <= 240 && Date.now() - lastActive.current < 120_000 && Date.now() - lastAuto.current > 30_000) { lastAuto.current = Date.now(); void more(); } }, [left]); // eslint-disable-line react-hooks/exhaustive-deps
  if (left === null || left > 120) return null;
  const m = Math.floor(Math.max(left, 0) / 60), sec = String(Math.max(left, 0) % 60).padStart(2, '0');
  return <div className="form-message session-warning" role="alert"><span>You have been away for a while. You will be signed out in {m}:{sec}, and anything half-typed will be lost.</span><Button onClick={() => void more()}>Stay signed in</Button>{msg && <span>{msg}</span>}</div>;
}

function Console() {
  const nav = useNavigate(); const [me, setMe] = useState<StaffMe | null>(null); const [eid, setEid] = useState(''); const [tick, setTick] = useState(0); const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [tab, setTab] = useState(tabFromHash);
  useEffect(() => { const on = () => { setTab(tabFromHash()); window.scrollTo({ top: 0 }); }; window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  const say: Say = useCallback((kind, text) => setFlash({ kind, text }), []);
  useEffect(() => { if (flash?.kind !== 'ok') return; const t = window.setTimeout(() => setFlash(null), 8000); return () => window.clearTimeout(t); }, [flash]);   // errors stay until dismissed
  const fail = useCallback((r: Extract<Call<unknown>, { ok: false }>) => { if (r.code === 'SESSION_ENDED') nav('/staff/login?ended=1', { replace: true }); else say('err', r.message); }, [nav, say]);
  const refresh = useCallback(async () => { const r = await staff.me(); if (!r.ok) return fail(r); setMe(r.data); setEid((cur) => cur || r.data.elections[0]?.id || ''); }, [fail]);
  useEffect(() => { void refresh(); }, [refresh]);
  const bump = useCallback(() => { setTick((t) => t + 1); void refresh(); }, [refresh]);
  async function signOut() { await staff.logout(); nav('/staff/login', { replace: true }); }
  const ended = useCallback(() => nav('/staff/login?ended=1', { replace: true }), [nav]);
  // How many requests wait for someone other than the person who made them. Checked every 30 seconds while the tab is open.
  const [waiting, setWaiting] = useState(0); const first = useRef(true); const [quick, setQuick] = useState<{ id: string; label: string } | null>(null); const [quickBusy, setQuickBusy] = useState(false);
  useEffect(() => {
    if (!me || me.role !== 'ADMIN' || !eid) return; let live = true;
    const check = async () => { if (document.hidden) return; const [a, p] = await Promise.all([staff.approvals(eid), staff.people()]); if (!live) return; const n = (a.ok ? a.data.pending.filter((x) => !x.mine).length : 0) + (p.ok ? p.data.pending.filter((x) => !x.mine).length : 0); const mine = a.ok ? a.data.pending.filter((x) => !x.mine) : []; const one = n === 1 && mine.length === 1 && INFO[mine[0].action as ActionName] && !INFO[mine[0].action as ActionName].final ? mine[0] : null; setQuick(one ? { id: one.id, label: INFO[one.action as ActionName].label } : null); setWaiting((was) => { if (was !== n && first.current === false) setTick((t) => t + 1); return n; }); first.current = false; };
    void check(); const t = window.setInterval(() => void check(), 30_000); return () => { live = false; window.clearInterval(t); };
  }, [me, eid, tick]);
  useEffect(() => { const base = document.title.replace(/^\(\d+\) /, ''); document.title = waiting > 0 ? `(${waiting}) ${base}` : base; return () => { document.title = base; }; }, [waiting]);
  if (!me) return <p role="status">Loading…</p>;
  const election = me.elections.find((e) => e.id === eid);
  return <><div className="page-head"><div><Eyebrow>{me.organization} · staff</Eyebrow><h1>Election <span className="highlight-word">operations.</span></h1><p>Signed in as {me.name}.</p></div><Button variant="quiet" onClick={() => void signOut()}><LogOut size={15} /> Sign out</Button></div>
    <SessionGuard onEnded={ended} />
    {waiting > 0 && <div className="form-message" role="status"><strong>{waiting} request{waiting === 1 ? ' is' : 's are'} waiting for your approval.</strong> <a href="#controls">Review now</a>{quick && <> <Button variant="secondary" disabled={quickBusy} onClick={() => { setQuickBusy(true); void staff.approve(quick.id).then((r) => { setQuickBusy(false); if (r.ok) { say('ok', `Done: ${quick.label}.`); setTick((t) => t + 1); } else if (r.code === 'SESSION_ENDED') fail(r); else say('err', r.message); }); }}>Approve: {quick.label}</Button></>}</div>}
    <Tools.Provider value={{ fail, say, refresh }}>
    {me.recovered && <div className="form-message" role="alert">You signed in with a recovery code. Replace your authenticator now, then make a new set of recovery codes. <a href="#account">Go to your account</a></div>}
    {me.role !== 'ADMIN' ? <><Card className="empty-state"><h2>This console is for administrators.</h2><p>Your account is a {me.role.toLowerCase()} account. You can still manage your own sign-in below.</p></Card><Account me={me} /></>
      : !election ? <Card className="empty-state"><h2>No election yet.</h2><p>This organization has no election to manage.</p></Card>
      : <Ctx.Provider value={{ election, tick, bump, fail, say }}>
        {me.elections.length > 1 && <div className="field"><label htmlFor="election-pick">Election</label><select id="election-pick" value={eid} onChange={(e) => setEid(e.target.value)}>{me.elections.map((e) => <option key={e.id} value={e.id}>{STATUS[e.status] ?? e.status} · {formatWhen(e.opensAt) || 'no date'}</option>)}</select></div>}
        <div className="status-strip" role="group" aria-label="Election status"><span>{me.elections.length > 1 ? 'This election is' : 'The election is'}</span><StatusPill tone={election.status === 'OPEN' && !election.paused && !election.frozen ? 'success' : 'warning'}>{STATUS[election.status] ?? election.status}</StatusPill>{election.paused && <StatusPill tone="warning">Paused</StatusPill>}{election.frozen && <StatusPill tone="alert">Frozen</StatusPill>}</div>
        <div className="console-shell">
          <nav aria-label="Console sections" className="console-nav">{TABS.map(([id, t]) => <a key={id} href={`#${id}`} className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined}>{t}{id === 'controls' && waiting > 0 ? <span className="count-badge">{waiting}<span className="sr-only"> waiting</span></span> : null}</a>)}</nav>
          <div className="console-body">
            <div hidden={tab !== 'summary'}><Summary /></div><div hidden={tab !== 'setup'}><Setup /></div><div hidden={tab !== 'controls'}><Controls /></div><div hidden={tab !== 'support'}><Support /></div><div hidden={tab !== 'results'}><Results /></div><div hidden={tab !== 'people'}><People /></div><div hidden={tab !== 'audit'}><AuditLog /></div><div hidden={tab !== 'account'}><Account me={me} /></div>
          </div>
        </div>
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
    <p className="next-step"><strong>What to do next</strong><span>{((NEXT[e.status] ?? 'Nothing to do right now.').replace(/^./, (c) => c.toUpperCase()))}{e.paused ? ' Voting is paused: resume it when ready.' : ''}{e.frozen ? ' Voting is frozen: see Approvals.' : ''}</span></p>
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
  async function go(c: Confirm | null = confirm) {
    if (!c) return; const confirm = c; setBusy(true);
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
    <p style={{ color: 'var(--muted)', fontSize: 13 }}>One administrator requests; a different administrator approves from their own sign-in. Pause, resume, extend and lift-freeze are approved with one click. Actions that cannot be undone ask you to confirm first.</p>
    <h3 style={{ margin: '0 0 8px' }}>Waiting for approval</h3>
    {!q?.pending.length ? <p>Nothing is waiting.</p> : <ul className="plain-list">{q.pending.map((p) => <li key={p.id} style={{ margin: '10px 0' }}><strong>{label(p.action, p.params)}</strong> · requested by {p.initiator}{p.mine ? ' (you)' : ''}, {formatWhen(p.createdAt)}
      <div className="control-row">{p.mine ? <span>Waiting for another administrator.</span> : <Button onClick={() => { const c: Confirm = { kind: 'approve', id: p.id, action: p.action as ActionName }; if (INFO[p.action as ActionName]?.final) setConfirm(c); else void go(c); }}>Approve<span className="sr-only"> {label(p.action, p.params)}</span></Button>}
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
// ---------------------------------------------------------------- setup (before the election is locked)
const DONE = <StatusPill tone="success">Done</StatusPill>;
const ROLL_WHY: Record<string, string> = { BAD_STUDENT_ID: 'the Student ID is empty or too long', DUPLICATE_IN_FILE: 'the Student ID appears twice in the file', ALREADY_ON_ROLL: 'that Student ID is already on the roll', BAD_CHANNEL: 'the voting channel is not valid', BAD_EMAIL: 'the email address is not valid', BAD_ATTRS: 'the extra details are not valid' };
const toLocalInput = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); if (Number.isNaN(d.getTime())) return ''; const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const csvCell = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
function parseRoll(text: string): { rows: { studentId: string; email?: string; attrs?: Record<string, string> }[]; dupes: string[]; skipped: number; columns: string[] } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean); const seen = new Set<string>(), rows: { studentId: string; email?: string; attrs?: Record<string, string> }[] = [], dupes: string[] = []; let skipped = 0;
  const split = (line: string) => line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
  const head = lines.length && /student|^id$|number|^no\.?$/i.test(split(lines[0])[0]) ? split(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim()) : null;
  const emailAt = head ? head.findIndex((h, i) => i > 0 && /^e-?mail/.test(h)) : 1; const attrCols = head ? head.map((h, i) => ({ h, i })).filter(({ h, i }) => i > 0 && i !== emailAt && h).slice(0, 10) : [];
  lines.forEach((line, i) => { if (head && i === 0) { skipped++; return; } const cells = split(line);
    const id = cells[0]; if (!id) { skipped++; return; } if (seen.has(id)) { dupes.push(id); return; } seen.add(id); const email = emailAt > 0 ? cells[emailAt] : undefined;
    const attrs: Record<string, string> = {}; attrCols.forEach(({ h, i: ci }) => { const v = (cells[ci] ?? '').trim(); if (v) attrs[h] = v.slice(0, 80); });
    rows.push({ studentId: id, ...(email ? { email } : {}), ...(Object.keys(attrs).length ? { attrs } : {}) }); });
  return { rows, dupes, skipped, columns: attrCols.map((c) => c.h) };
}
const readFile = (f: File | undefined, set: (t: string) => void) => { if (f) void f.text().then(set); };

function Setup() {
  const { election: e, tick, fail, say } = useContext(Ctx); const [o, setO] = useState<SetupOverview | null>(null);
  const reload = useCallback(async () => { const r = await staff.setup(e.id); if (r.ok) setO(r.data); else fail(r); }, [e.id, fail]);
  useEffect(() => { void reload(); }, [reload, tick]);
  const bad = (r: Extract<Call<unknown>, { ok: false }>) => r.code === 'SESSION_ENDED' ? fail(r) : say('err', r.message);
  if (!o) return <Section id="setup" eyebrow="Set up the election" title="Setup"><p role="status">Loading…</p></Section>;
  const editable = o.status === 'DRAFT' || o.status === 'CONFIGURED', timesOpen = editable || o.status === 'LOCKED';
  const steps = [o.opensAt && o.closesAt, o.positions.length > 0 && o.positions.every((p) => p.candidates.length > 0), o.rollCount > 0, o.rollCount > 0 && o.withoutVoucher === 0, o.electionKeySet && o.signingKeySet];
  const left = steps.filter((s) => !s).length;
  return <Section id="setup" eyebrow="Set up the election" title="Setup"><Card>
    {timesOpen ? <p>{left === 0 ? <><strong>Everything is set up.</strong> {editable ? 'When you are ready, request “Lock the election” under Approvals and controls.' : ''}</> : <><strong>{left} of 5 steps left.</strong> Do them in any order. You can change things until the election is locked.</>}</p>
      : <p><strong>Setup is finished.</strong> The election is {o.status.toLowerCase()}, so nothing here can be changed any more. This is what was set up.</p>}
    <ol className="plain-list" aria-label="Setup steps">{['Voting times', 'Positions and candidates', 'Voter roll', 'Voucher codes', 'Keys'].map((n, i) => <li key={n}>{steps[i] ? '✓' : '○'} {n}</li>)}</ol>
  </Card>
    <SetupTimes o={o} open={timesOpen} reload={reload} bad={bad} say={say} id={e.id} />
    <SetupPositions o={o} editable={editable} reload={reload} bad={bad} say={say} id={e.id} />
    <SetupRoll o={o} editable={editable} reload={reload} bad={bad} say={say} id={e.id} />
    <SetupVouchers o={o} reload={reload} bad={bad} say={say} id={e.id} />
    <SetupKeys o={o} open={timesOpen} reload={reload} bad={bad} say={say} id={e.id} />
  </Section>;
}
type SP = { o: SetupOverview; reload: () => Promise<void>; bad: (r: Extract<Call<unknown>, { ok: false }>) => void; say: Say; id: string };

function SetupTimes({ o, open, reload, bad, say, id }: SP & { open: boolean }) {
  async function save(ev: FormEvent<HTMLFormElement>) { ev.preventDefault(); const f = new FormData(ev.currentTarget); const a = String(f.get('opens')), b = String(f.get('closes'));
    if (!a || !b) return say('err', 'Choose both a time to open and a time to close.');
    const r = await staff.setWindow(id, new Date(a).toISOString(), new Date(b).toISOString()); if (r.ok) { say('ok', 'Voting times saved.'); void reload(); } else bad(r); }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <Card><h3 style={h2}>1 · Voting times {o.opensAt && o.closesAt && DONE}</h3>
    {o.opensAt && o.closesAt && <p>Now set: opens <strong>{formatWhen(o.opensAt)}</strong>, closes <strong>{formatWhen(o.closesAt)}</strong>.</p>}
    {open ? <form onSubmit={(ev) => void save(ev)} className="control-row" style={{ alignItems: 'end' }} key={`${o.opensAt}${o.closesAt}`}>
      <div className="field"><label htmlFor="t-open">Voting opens</label><input id="t-open" name="opens" type="datetime-local" defaultValue={toLocalInput(o.opensAt)} required /></div>
      <div className="field"><label htmlFor="t-close">Voting closes</label><input id="t-close" name="closes" type="datetime-local" defaultValue={toLocalInput(o.closesAt)} required /></div>
      <Button type="submit" variant="secondary">Save times</Button></form> : null}
    {open && <p style={{ color: 'var(--muted)', fontSize: 13 }}>Times are in this device’s time zone ({zone}). Voting only starts when two administrators approve “Open voting”; these times set the window. You can still extend voting later.</p>}
  </Card>;
}

const scopeText = (sc: Scope) => 'match' in sc ? Object.entries(sc.match).map(([k, v]) => `${k} is ${v}`).join(' and ') : 'Everyone';
const SEP = '\u001f';
function ScopePicker({ attrs, value, id }: { attrs: Record<string, string[]>; value: Scope; id: string }) {
  const opts: string[] = []; Object.entries(attrs).forEach(([k, vs]) => vs.forEach((v) => opts.push(`${k}${SEP}${v}`)));
  const cur = 'match' in value ? Object.entries(value.match).map(([k, v]) => `${k}${SEP}${v}`)[0] : ''; if (cur && !opts.includes(cur)) opts.push(cur);
  if (!opts.length) return <small>Everyone on the roll can vote on this. To limit a position to one program or year, add that column to the roll file (the first line names the columns).</small>;
  return <div className="field"><label htmlFor={id}>Who can vote on this</label><select id={id} name="scope" defaultValue={cur}><option value="">Everyone on the roll</option>{opts.map((o) => { const [k, v] = o.split(SEP); return <option key={o} value={o}>Only voters whose {k} is {v}</option>; })}</select></div>;
}
const readScope = (f: FormData): Scope => { const v = String(f.get('scope') ?? ''); if (!v) return { all: true }; const [k, val] = v.split(SEP); return { match: { [k]: val } }; };
// Shrinks a picture in the browser to a 400 px square JPEG (centre crop) so it is small, and so only a plain JPEG ever reaches the server.
async function shrinkPhoto(file: File): Promise<string> {
  if (!/^image\//.test(file.type)) throw new Error('Choose a picture file (JPG or PNG).');
  let bmp: ImageBitmap; try { bmp = await createImageBitmap(file); } catch { throw new Error('This picture could not be read. Use a JPG or PNG.'); }
  const size = 400, c = document.createElement('canvas'); c.width = size; c.height = size; const g = c.getContext('2d'); if (!g) throw new Error('This browser cannot prepare pictures.');
  const side = Math.min(bmp.width, bmp.height); g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size); bmp.close();
  for (const q of [0.85, 0.7, 0.55]) { const blob: Blob | null = await new Promise((res) => c.toBlob(res, 'image/jpeg', q)); if (blob && blob.size <= 200_000) return await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(new Error('Could not read the picture.')); r.readAsDataURL(blob); }); }
  throw new Error('That picture is still too large after shrinking. Try a simpler one.');
}

function SetupPositions({ o, editable, reload, bad, say, id }: SP & { editable: boolean }) {
  const [ask, setAsk] = useState<string | null>(null); const [edit, setEdit] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [ver, setVer] = useState(() => String(Date.now()));
  async function addPosition(ev: FormEvent<HTMLFormElement>) { ev.preventDefault(); const form = ev.currentTarget, f = new FormData(form); const seats = Number(f.get('seats'));
    if (!Number.isInteger(seats) || seats < 1 || seats > 20) return say('err', 'Seats must be a whole number from 1 to 20.');
    const r = await staff.addPosition(id, String(f.get('title')).trim(), seats, 0, f.get('abstain') === 'on', readScope(f)); if (r.ok) { form.reset(); say('ok', 'Position added. Add its candidates below it.'); void reload(); } else bad(r); }
  async function savePosition(ev: FormEvent<HTMLFormElement>, pid: string) { ev.preventDefault(); const f = new FormData(ev.currentTarget); const seats = Number(f.get('seats'));
    if (!Number.isInteger(seats) || seats < 1 || seats > 20) return say('err', 'Seats must be a whole number from 1 to 20.');
    const r = await staff.editPosition(id, pid, String(f.get('title')).trim(), seats, f.get('abstain') === 'on', readScope(f)); if (r.ok) { setEdit(null); say('ok', 'Position saved.'); void reload(); } else bad(r); }
  async function saveCandidate(ev: FormEvent<HTMLFormElement>, cid: string) { ev.preventDefault(); const f = new FormData(ev.currentTarget); setBusy(true);
    try { const file = (f.get('photo') as File | null); if (file && file.size > 0) { const img = await shrinkPhoto(file); const pr = await staff.setCandidatePhoto(id, cid, img); if (!pr.ok) { setBusy(false); return bad(pr); } setVer(String(Date.now())); }
      const r = await staff.editCandidate(id, cid, String(f.get('name')).trim(), String(f.get('platform') ?? '').trim()); setBusy(false); if (r.ok) { setEdit(null); say('ok', 'Candidate saved.'); void reload(); } else bad(r);
    } catch (e) { setBusy(false); say('err', e instanceof Error ? e.message : 'Could not save.'); } }
  async function dropPhoto(cid: string) { const r = await staff.removeCandidatePhoto(id, cid); if (r.ok) { setVer(String(Date.now())); say('ok', 'Photo removed.'); void reload(); } else bad(r); }
  async function addCandidates(ev: FormEvent<HTMLFormElement>, positionId: string) { ev.preventDefault(); const form = ev.currentTarget; const lines = String(new FormData(form).get('names')).split(/\r?\n/).map((l) => l.trim()).filter(Boolean); if (!lines.length) return; setBusy(true); let n = 0;
    for (const line of lines) { const [name, ...rest] = line.split('|'); const r = await staff.addCandidate(id, positionId, name.trim(), rest.join('|').trim()); if (!r.ok) { setBusy(false); void reload(); return bad(r); } n++; }
    setBusy(false); form.reset(); say('ok', n === 1 ? 'Candidate added.' : `${n} candidates added.`); void reload(); }
  async function remove(kind: 'position' | 'candidate', rid: string) { setAsk(null); const r = kind === 'position' ? await staff.removePosition(id, rid) : await staff.removeCandidate(id, rid); if (r.ok) { say('ok', 'Removed.'); void reload(); } else bad(r); }
  const ok = o.positions.length > 0 && o.positions.every((p) => p.candidates.length > 0);
  return <Card><h3 style={h2}>2 · Positions and candidates {ok && DONE}</h3>
    {!o.positions.length && <p>No positions yet.{editable ? ' Add the first one below.' : ''}</p>}
    {o.positions.map((p) => <div key={p.id} style={{ borderTop: '1px solid var(--line)', padding: '12px 0' }}>
      <div className="control-row" style={{ justifyContent: 'space-between' }}><strong>{p.title}</strong><span style={{ color: 'var(--muted)', fontSize: 13 }}>{p.seats} seat{p.seats === 1 ? '' : 's'} · {p.allowAbstain ? 'voters may abstain' : 'no abstain'} · {scopeText(p.scope)}{o.rollCount ? ` (${p.eligible} voter${p.eligible === 1 ? '' : 's'})` : ''}</span>
        {editable && <span className="control-row"><Button variant="quiet" onClick={() => setEdit(edit === p.id ? null : p.id)}>{edit === p.id ? 'Cancel' : 'Edit'}<span className="sr-only"> {p.title}</span></Button>
          {ask === p.id ? <span className="control-row"><span>Remove {p.title}{p.candidates.length ? ` and its ${p.candidates.length} candidate${p.candidates.length === 1 ? '' : 's'}` : ''}?</span><Button variant="secondary" onClick={() => void remove('position', p.id)}>Yes, remove</Button><Button variant="quiet" onClick={() => setAsk(null)}>Keep</Button></span> : <Button variant="quiet" onClick={() => setAsk(p.id)}>Remove<span className="sr-only"> position {p.title}</span></Button>}</span>}</div>
      {o.rollCount > 0 && p.eligible === 0 && <div className="form-message" role="alert">No voter on the roll can vote on this position. Check “Who can vote on this”.</div>}
      {edit === p.id && <form onSubmit={(ev) => void savePosition(ev, p.id)} className="control-row" style={{ alignItems: 'end' }}>
        <div className="field"><label htmlFor={`pt-${p.id}`}>Position name</label><input id={`pt-${p.id}`} name="title" defaultValue={p.title} maxLength={120} required /></div>
        <div className="field" style={{ maxWidth: 110 }}><label htmlFor={`ps-${p.id}`}>Seats</label><input id={`ps-${p.id}`} name="seats" type="number" min={1} max={20} defaultValue={p.seats} required /></div>
        <label className="checkline"><input type="checkbox" name="abstain" defaultChecked={p.allowAbstain} /> <span>Voters may abstain</span></label>
        <ScopePicker attrs={o.attributes} value={p.scope} id={`pw-${p.id}`} /><Button type="submit">Save position</Button></form>}
      {!p.candidates.length && <p style={{ color: 'var(--muted)' }}>No candidates yet.</p>}
      <ul className="plain-list">{p.candidates.map((c) => <li key={c.id} style={{ padding: '6px 0' }}>
        <div className="control-row" style={{ justifyContent: 'space-between' }}><span className="control-row">{c.hasPhoto ? <img src={staff.photoUrl(id, c.id, ver)} alt={`Photo of ${c.name}`} width={40} height={40} style={{ borderRadius: 8, objectFit: 'cover' }} /> : null}<span>{c.name}{c.platform ? <span style={{ color: 'var(--muted)' }}> · {c.platform}</span> : null}</span></span>
          {editable && <span className="control-row"><Button variant="quiet" onClick={() => setEdit(edit === c.id ? null : c.id)}>{edit === c.id ? 'Cancel' : 'Edit'}<span className="sr-only"> {c.name}</span></Button>
            {ask === c.id ? <span className="control-row"><Button variant="secondary" onClick={() => void remove('candidate', c.id)}>Yes, remove {c.name}</Button><Button variant="quiet" onClick={() => setAsk(null)}>Keep</Button></span> : <Button variant="quiet" onClick={() => setAsk(c.id)}>Remove<span className="sr-only"> {c.name}</span></Button>}</span>}</div>
        {edit === c.id && <form onSubmit={(ev) => void saveCandidate(ev, c.id)} style={{ paddingTop: 8 }}>
          <div className="field"><label htmlFor={`cn-${c.id}`}>Name</label><input id={`cn-${c.id}`} name="name" defaultValue={c.name} maxLength={120} required /></div>
          <div className="field"><label htmlFor={`cp-${c.id}`}>Statement shown to voters (optional)</label><textarea id={`cp-${c.id}`} name="platform" rows={3} maxLength={1000} defaultValue={c.platform ?? ''} /></div>
          <div className="field"><label htmlFor={`cf-${c.id}`}>{c.hasPhoto ? 'Replace the photo' : 'Photo (optional)'}</label><input id={`cf-${c.id}`} name="photo" type="file" accept="image/jpeg,image/png,image/webp" /><small>A square picture works best. It is shrunk to 400 × 400 pixels here. Only use a picture the candidate gave you permission to publish. Voters see it on the ballot once the election is locked.</small></div>
          <div className="control-row"><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save candidate'}</Button>{c.hasPhoto && <Button type="button" variant="quiet" onClick={() => void dropPhoto(c.id)}>Remove photo</Button>}</div></form>}
      </li>)}</ul>
      {editable && <form onSubmit={(ev) => void addCandidates(ev, p.id)}><div className="field"><label htmlFor={`cand-${p.id}`}>Add candidates to {p.title}</label><textarea id={`cand-${p.id}`} name="names" rows={2} placeholder={'One name per line. Add a short statement after a bar:\nJuan Dela Cruz | Free printing for every college'} /><small>Voters see candidates in alphabetical order. Add photos with Edit.</small></div><Button type="submit" variant="secondary" disabled={busy}>Add</Button></form>}
    </div>)}
    {editable && <form onSubmit={(ev) => void addPosition(ev)} className="control-row" style={{ alignItems: 'end', borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <div className="field"><label htmlFor="pos-title">New position</label><input id="pos-title" name="title" maxLength={120} placeholder="President" required /></div>
      <div className="field" style={{ maxWidth: 110 }}><label htmlFor="pos-seats">Seats</label><input id="pos-seats" name="seats" type="number" min={1} max={20} defaultValue={1} required /></div>
      <label className="checkline"><input type="checkbox" name="abstain" defaultChecked /> <span>Voters may abstain</span></label>
      <ScopePicker attrs={o.attributes} value={{ all: true }} id="pos-scope" />
      <Button type="submit" variant="secondary">Add position</Button></form>}
  </Card>;
}

function SetupRoll({ o, editable, reload, bad, say, id }: SP & { editable: boolean }) {
  const [text, setText] = useState(''); const [errs, setErrs] = useState<{ row: number; reason: string }[] | null>(null); const [busy, setBusy] = useState(false); const [ask, setAsk] = useState(false);
  const parsed = parseRoll(text); const anyVoucher = o.rollCount > o.withoutVoucher;
  async function run() { setBusy(true); setErrs(null); const r = await staff.importRoll(id, parsed.rows); setBusy(false);
    if (!r.ok) return bad(r); if (r.data.ok) { setText(''); say('ok', `${r.data.inserted} voters added to the roll.`); void reload(); } else setErrs(r.data.errors); }
  async function clear() { setAsk(false); const r = await staff.clearRoll(id); if (r.ok) { say('ok', `Roll cleared (${r.data.removed} voters removed).`); void reload(); } else bad(r); }
  return <Card><h3 style={h2}>3 · Voter roll {o.rollCount > 0 && DONE}</h3>
    <p>{o.rollCount ? <><strong>{o.rollCount}</strong> voter{o.rollCount === 1 ? ' is' : 's are'} on the roll.</> : 'The roll is empty.'}</p>
    {editable && !o.rollCount && <>
      <div className="field"><label htmlFor="roll-file">Choose a CSV or text file</label><input id="roll-file" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(ev) => readFile(ev.target.files?.[0], setText)} /><small>One voter per line: Student ID, then an optional email. To limit some positions to a group, start with a header line such as <code>studentId,email,program,year</code>. Every extra column becomes something a position can be limited by. Everyone votes online.</small></div>
      <div className="field"><label htmlFor="roll-text">Or paste the list here</label><textarea id="roll-text" rows={5} value={text} onChange={(ev) => { setText(ev.target.value); setErrs(null); }} placeholder={'2026-00001, juan@ctu.edu.ph\n2026-00002'} style={{ fontFamily: 'ui-monospace,monospace' }} /></div>
      {text.trim() && <p role="status"><strong>{parsed.rows.length}</strong> voter{parsed.rows.length === 1 ? '' : 's'} found{parsed.dupes.length ? `. ${parsed.dupes.length} repeated Student ID${parsed.dupes.length === 1 ? ' is' : 's are'} ignored (${parsed.dupes.slice(0, 3).join(', ')}${parsed.dupes.length > 3 ? '…' : ''})` : ''}{parsed.skipped ? `. ${parsed.skipped} header or blank line${parsed.skipped === 1 ? '' : 's'} skipped` : ''}.{parsed.columns.length ? ` Extra columns kept: ${parsed.columns.join(', ')}.` : ''}</p>}
      {errs && <div className="form-message" role="alert"><strong>Nothing was imported.</strong> Fix these and try again:<ul>{errs.slice(0, 10).map((x) => <li key={x.row}>Row {x.row}: {ROLL_WHY[x.reason] ?? x.reason}.</li>)}</ul>{errs.length > 10 && <p>…and {errs.length - 10} more.</p>}</div>}
      <Button disabled={!parsed.rows.length || busy} onClick={() => void run()}>{busy ? 'Importing…' : `Import ${parsed.rows.length || ''} voters`}</Button></>}
    {editable && o.rollCount > 0 && (anyVoucher ? <p style={{ color: 'var(--muted)', fontSize: 13 }}>Voucher codes were already issued, so the roll can no longer be replaced.</p>
      : ask ? <p className="control-row"><span>Remove all {o.rollCount} voters and start again?</span><Button variant="secondary" onClick={() => void clear()}>Yes, clear the roll</Button><Button variant="quiet" onClick={() => setAsk(false)}>Keep</Button></p>
      : <Button variant="quiet" onClick={() => setAsk(true)}>Clear the roll and start again</Button>)}
  </Card>;
}

function SetupVouchers({ o, reload, bad, say, id }: SP) {
  const [issued, setIssued] = useState<{ studentId: string; code: string }[] | null>(null); const [busy, setBusy] = useState(false);
  async function issue() { setBusy(true); const r = await staff.issueVouchers(id); setBusy(false); if (!r.ok) return bad(r); setIssued(r.data.vouchers); say('ok', `${r.data.issued} voucher codes issued.`); void reload(); }
  const csv = issued ? 'studentId,code\n' + issued.map((v) => `${csvCell(v.studentId)},${csvCell(v.code)}`).join('\n') : '';
  return <Card><h3 style={h2}>4 · Voucher codes {o.rollCount > 0 && o.withoutVoucher === 0 && DONE}</h3>
    {!o.rollCount ? <p>Import the voter roll first.</p> : <p>{o.withoutVoucher ? <><strong>{o.withoutVoucher}</strong> of {o.rollCount} voters still need a code.</> : 'Every voter has a code.'}</p>}
    {o.rollCount > 0 && o.withoutVoucher > 0 && <><p style={{ color: 'var(--muted)', fontSize: 13 }}>Each voter uses their code once, to create their account. Codes expire <strong>7 days</strong> after they are issued, so issue them close to when voters should register. The codes are shown <strong>only once</strong>, right after you press the button.</p><Button disabled={busy} onClick={() => void issue()}>{busy ? 'Issuing…' : `Issue ${o.withoutVoucher} codes`}</Button></>}
    {issued && <div className="alert-box alert-warning" role="alert" style={{ marginTop: 14 }}><strong>Save these now. They will not be shown again.</strong>
      <p>{issued.length} codes. Download the file and hand each student their own code through your official channel.</p>
      <CopyTools text={csv} file="voucher-codes.csv" /><p><button type="button" className="link-button" onClick={() => setIssued(null)}>I have saved the file. Hide the codes.</button></p></div>}
  </Card>;
}

const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
function SetupKeys({ o, open, reload, bad, say, id }: SP & { open: boolean }) {
  return <Card><h3 style={h2}>5 · Keys {o.electionKeySet && o.signingKeySet && DONE}</h3>
    <p>The two public keys come from the key ceremony the key holders run offline: <code>node packages/cli/ev.mjs keygen --out ./keys</code>. It writes <code>election.pub</code> and <code>signing.pub</code>. Register only those two files here. <strong>Never</strong> put <code>share-*.txt</code> or <code>signing.key</code> into any website.</p>
    <KeyForm title="Election key (encrypts the ballots)" file="election.pub" set={o.electionKeySet} open={open} send={(k) => staff.setElectionKey(id, k)} reload={reload} bad={bad} say={say} />
    <KeyForm title="Signing key (signs the results)" file="signing.pub" set={o.signingKeySet} open={open} send={(k) => staff.setSigningKey(id, k)} reload={reload} bad={bad} say={say} />
  </Card>;
}
function KeyForm({ title, file, set, open, send, reload, bad, say }: { title: string; file: string; set: boolean; open: boolean; send: (k: string) => Promise<Call<{ ok: boolean; fingerprint: string }>>; reload: () => Promise<void>; bad: SP['bad']; say: Say }) {
  const [v, setV] = useState(''); const [err, setErr] = useState(''); const [fp, setFp] = useState('');
  async function submit(ev: FormEvent) { ev.preventDefault(); const k = v.trim(); setErr('');
    if (!KEY_RE.test(k)) return setErr(k.length > 60 ? 'That is much longer than a public key. It may be a private key or a share. Do not paste it anywhere. Use the .pub file.' : `That is not a public key. Use the text from ${file}: 44 letters and numbers ending in =.`);
    const r = await send(k); if (r.ok) { setFp(r.data.fingerprint); setV(''); say('ok', 'Key registered. Check the fingerprint against the ceremony printout.'); void reload(); } else bad(r); }
  return <div style={{ borderTop: '1px solid var(--line)', padding: '12px 0' }}><strong>{title}</strong> {set ? <StatusPill tone="success">Registered</StatusPill> : <StatusPill tone="warning">Not registered</StatusPill>}
    {fp && <p role="status">Fingerprint: <code>{fp}</code>. Compare it with what the key holders recorded. If it differs, register the key again before the election is locked.</p>}
    {open ? <form onSubmit={(ev) => void submit(ev)}><div className="field"><label htmlFor={`k-${file}`}>{set ? 'Replace with' : 'Paste'} the text of {file}</label><input id={`k-${file}`} value={v} onChange={(ev) => setV(ev.target.value)} autoComplete="off" spellCheck={false} style={{ fontFamily: 'ui-monospace,monospace' }} />
      <small>Or <label className="link-button" style={{ cursor: 'pointer' }}>choose the file<input type="file" accept=".pub,.txt" style={{ display: 'none' }} onChange={(ev) => readFile(ev.target.files?.[0], (t) => setV(t.trim()))} /></label>.</small></div>{err && <div className="form-message" role="alert">{err}</div>}<Button type="submit" variant="secondary" disabled={!v.trim()}>Register key</Button></form> : null}
  </div>;
}

function SupportItem({ row, onSaved }: { row: SupportRow; onSaved: () => void }) {
  const { fail, say } = useContext(Ctx); const [status, setStatus] = useState(row.status); const [note, setNote] = useState(row.note ?? '');
  async function save(event: FormEvent | null, to = status) { event?.preventDefault(); const r = await staff.setSupportStatus(row.id, to, note); if (!r.ok) return fail(r); say('ok', `${row.ref} saved.`); onSaved(); }
  return <li className="card" style={{ margin: '12px 0', boxShadow: 'none' }}>
    <div className="control-row"><strong>{row.ref}</strong><StatusPill>{KIND[row.kind]}</StatusPill><span style={{ color: 'var(--muted)', fontSize: 12 }}>{formatWhen(row.created_at)}</span></div>
    {row.student_id && <p style={{ margin: '6px 0' }}>Student ID <strong>{row.student_id}</strong> · {row.on_roll ? 'on the roll' : 'not on the roll'} · {row.session_verified ? 'signed in as this student' : 'not verified'}</p>}
    {row.subject && <p style={{ margin: '6px 0' }}><strong>{row.subject}</strong></p>}
    {row.details && <p style={{ margin: '6px 0', whiteSpace: 'pre-wrap' }}>{row.details}</p>}
    {row.url && <p style={{ margin: '6px 0' }}>Reported address (do not open): <code>{row.url}</code></p>}
    <form onSubmit={(ev) => void save(ev)} className="control-row" style={{ alignItems: 'end' }}>
      <div className="field"><label htmlFor={`st-${row.id}`}>Status of {row.ref}</label><select id={`st-${row.id}`} value={status} onChange={(ev) => setStatus(ev.target.value)}><option value="NEW">New</option><option value="IN_REVIEW">In review</option><option value="RESOLVED">Resolved</option><option value="DISMISSED">Dismissed</option></select></div>
      <div className="field"><label htmlFor={`nt-${row.id}`}>Note for {row.ref}</label><input id={`nt-${row.id}`} value={note} maxLength={2000} onChange={(ev) => setNote(ev.target.value)} /></div>
      <Button type="submit" variant="secondary" disabled={status === row.status && note === (row.note ?? '')}>Save<span className="sr-only"> {row.ref}</span></Button></form>
    <div className="control-row" aria-label={`Quick actions for ${row.ref}`}>{row.status === 'NEW' && <Button variant="quiet" onClick={() => void save(null, 'IN_REVIEW')}>Start review<span className="sr-only"> {row.ref}</span></Button>}{row.status !== 'RESOLVED' && <Button onClick={() => void save(null, 'RESOLVED')}>Mark resolved<span className="sr-only"> {row.ref}</span></Button>}{row.status !== 'DISMISSED' && row.status !== 'RESOLVED' && <Button variant="quiet" onClick={() => void save(null, 'DISMISSED')}>Dismiss<span className="sr-only"> {row.ref}</span></Button>}</div></li>;
}
function Support() {
  const { election: e, tick, fail } = useContext(Ctx); const [rows, setRows] = useState<SupportRow[] | null>(null); const [status, setStatus] = useState('NEW'); const [kind, setKind] = useState('');
  const [sid, setSid] = useState(''); const [code, setCode] = useState<{ studentId: string; claimCode: string; validDays: number } | null>(null); const [codeErr, setCodeErr] = useState(''); const [reload, setReload] = useState(0);
  useEffect(() => { let on = true; void staff.support(e.id, status, kind).then((r) => { if (!on) return; r.ok ? setRows(r.data.requests) : fail(r); }); return () => { on = false; }; }, [e.id, tick, status, kind, reload, fail]);
  useEffect(() => { setCode(null); }, [e.id]);
  async function issue(event: FormEvent) { event.preventDefault(); setCodeErr(''); setCode(null); const r = await staff.issueClaimCode(e.id, sid.trim()); if (r.ok) { setCode(r.data); setSid(''); document.getElementById('claim-student')?.focus(); } else if (r.code === 'SESSION_ENDED') fail(r); else setCodeErr(r.code === 'NOT_FOUND' || r.code === 'GATE_NOT_FOUND' ? 'No online voter with that Student ID can be given a claim code in this election.' : r.message); }
  return <Section id="support" eyebrow="03 · Support requests" title="Protests, disputes and reports"><Card>
    <div className="control-row"><div className="field"><label htmlFor="f-status">Show status</label><select id="f-status" value={status} onChange={(ev) => setStatus(ev.target.value)}><option value="">All</option><option value="NEW">New</option><option value="IN_REVIEW">In review</option><option value="RESOLVED">Resolved</option><option value="DISMISSED">Dismissed</option></select></div>
      <div className="field"><label htmlFor="f-kind">Show kind</label><select id="f-kind" value={kind} onChange={(ev) => setKind(ev.target.value)}><option value="">All</option><option value="protest">Protests</option><option value="dispute">Account disputes</option><option value="report">Fake-site reports</option></select></div></div>
    {!rows ? <p>Loading…</p> : !rows.length ? <p>{status === 'NEW' ? 'No new requests. Nothing needs you here.' : 'No requests match.'} {status === 'NEW' && <button type="button" className="link-button" onClick={() => setStatus('')}>Show all requests</button>}</p> : <ul className="plain-list" aria-label="Support requests">{rows.map((r) => <SupportItem key={`${r.id}-${r.status}-${r.note ?? ''}`} row={r} onSaved={() => setReload((n) => n + 1)} />)}</ul>}
    <h3 style={{ margin: '18px 0 8px' }}>Give a student an in-person claim code</h3>
    <p style={{ color: 'var(--muted)', fontSize: 13 }}>Check the student’s school ID first. Issuing a code also blocks password reset on that account until the code is used, so whoever holds it now cannot reset it.</p>
    <form onSubmit={(ev) => void issue(ev)} className="control-row" style={{ alignItems: 'end' }}><div className="field"><label htmlFor="claim-student">Student ID</label><input id="claim-student" value={sid} onChange={(ev) => setSid(ev.target.value)} maxLength={32} required /></div><Button type="submit" variant="secondary">Issue claim code</Button></form>
    {codeErr && <div className="form-message" role="alert">{codeErr}</div>}
    {code && <div className="form-message" role="status"><p style={{ margin: 0 }}>Claim code for {code.studentId}: <strong style={{ fontSize: 22, letterSpacing: 2 }}>{code.claimCode}</strong> <CopyTools text={code.claimCode} /></p><p style={{ margin: '6px 0' }}>It is shown only once and is valid for {code.validDays} days. Give it to the student in person.</p><Button variant="quiet" onClick={() => setCode(null)}>Done, hide it</Button></div>}
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
  const [showNew, setShowNew] = useState(false); const [pw, setPw] = useState<{ ok: boolean; text: string } | null>(null), [auth, setAuth] = useState<{ ok: boolean; text: string } | null>(null), [rec, setRec] = useState<{ ok: boolean; text: string } | null>(null);
  const [enroll, setEnroll] = useState<{ secret: string; uri: string } | null>(null), [codes, setCodes] = useState<string[] | null>(null);
  const field = (f: FormData, n: string) => String(f.get(n) || '');
  async function changePassword(ev: FormEvent<HTMLFormElement>) { ev.preventDefault(); const f = new FormData(ev.currentTarget), form = ev.currentTarget;
    if (field(f, 'next') !== field(f, 'confirm')) return setPw({ ok: false, text: 'The two new passwords do not match.' });
    const r = await staff.changePassword(field(f, 'current'), field(f, 'next')); if (r.ok) { setPw({ ok: true, text: 'Password changed. Any other place you were signed in has been signed out.' }); form.reset(); setShowNew(false); } else if (r.code === 'SESSION_ENDED') fail(r); else setPw({ ok: false, text: r.message }); }
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
      <div className="field"><label htmlFor="pw-next">New password (at least 12 characters)</label><input id="pw-next" name="next" type={showNew ? 'text' : 'password'} autoComplete="new-password" minLength={12} required /><label className="checkline"><input type="checkbox" checked={showNew} onChange={(e) => setShowNew(e.target.checked)} /> <span>Show what I type, so I can check it</span></label></div>
      <div className="field"><label htmlFor="pw-confirm">Confirm new password</label><input id="pw-confirm" name="confirm" type={showNew ? 'text' : 'password'} autoComplete="new-password" minLength={12} required /></div>
      {msg(pw)}<Button type="submit" variant="secondary">Change password</Button></form>
    <h3 style={{ margin: '20px 0 8px' }}>Replace your authenticator</h3>
    <p style={{ fontSize: 13 }}>Use this when you get a new phone. The old authenticator keeps working until the new one proves itself.</p>
    {!enroll ? <form onSubmit={(ev) => void startAuth(ev)}><div className="field"><label htmlFor="auth-password">Your password</label><input id="auth-password" name="password" type="password" autoComplete="current-password" required /></div>{msg(auth)}<Button type="submit" variant="secondary">Start replacing</Button></form>
      : <form onSubmit={(ev) => void confirmAuth(ev)}><div className="qr-help"><QrBox uri={enroll.uri} /><p>Scan this picture with your authenticator app, or choose “enter a setup key”, or <a href={enroll.uri}>open it in the app</a> on this device.</p></div><p><code aria-label="New authenticator setup key" style={{ fontSize: 18, letterSpacing: 1, wordBreak: 'break-all' }}>{groups(enroll.secret)}</code></p>
        <div className="field"><label htmlFor="auth-code">6-digit code from the new entry</label><input id="auth-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></div>{msg(auth)}
        <div className="control-row"><Button type="submit">Confirm new authenticator</Button><Button type="button" variant="quiet" onClick={() => setEnroll(null)}>Cancel</Button></div></form>}
    <h3 style={{ margin: '20px 0 8px' }}>Recovery codes</h3>
    <p style={{ fontSize: 13 }}>Each code signs you in once if you lose your phone. Making a new set cancels the old codes.</p>
    <form onSubmit={(ev) => void newCodes(ev)}><div className="field"><label htmlFor="rec-password">Your password</label><input id="rec-password" name="password" type="password" autoComplete="current-password" required /></div>{msg(rec)}<Button type="submit" variant="secondary">Make new recovery codes</Button></form>
    {codes && <div className="form-message" role="status"><p style={{ margin: 0 }}>Your new recovery codes. They are shown only now.</p><ul className="plain-list recovery" aria-label="New recovery codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul><CopyTools text={codes.join('\n')} file="recovery-codes.txt" /><Button variant="quiet" onClick={() => setCodes(null)}>Done, hide them</Button></div>}
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
    {reveal && <div className="form-message" role="status"><p style={{ margin: 0 }}>Setup code for {reveal.username}: <strong style={{ fontSize: 22, letterSpacing: 2 }}>{reveal.setupCode}</strong> <CopyTools text={reveal.setupCode} /></p><p style={{ margin: '6px 0' }}>It is shown only once and works once, for {reveal.validDays} days. Give it to them in person. They open <strong>/staff/setup</strong> to choose their own password and connect their authenticator.</p><Button variant="quiet" onClick={() => setReveal(null)}>Done, hide it</Button></div>}
  </Card></Section>;
}
