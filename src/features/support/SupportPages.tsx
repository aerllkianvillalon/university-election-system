import { useState, type FormEvent } from 'react';
import { Link, Navigate, NavLink, useParams } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { api } from '../../lib/api/client';
import { GENERIC_FAILURE_MESSAGE, type SupportKind } from '../../lib/api/types';
import { Button, Card, Eyebrow } from '../../components/ui/Primitives';

type Field = [name: string, label: string, type: 'text' | 'password' | 'area'];
const COPY: Record<SupportKind, { title: string; intro: string; fields: Field[]; cta: string }> = {
  claim: { title: 'Claim your account in person', intro: 'Enter the one-time claim code you received at the registration desk, then choose a password.',
    fields: [['studentId', 'Student ID', 'text'], ['claimCode', 'Claim code', 'text'], ['password', 'New password', 'password']], cta: 'Claim account' },
  protest: { title: 'File an election protest', intro: 'The Electoral Committee reviews protests within the protest period set in your organization’s rules. Never include your ballot choices.',
    fields: [['studentId', 'Student ID', 'text'], ['subject', 'What are you protesting?', 'text'], ['details', 'Details', 'area']], cta: 'Submit protest' },
  dispute: { title: 'Dispute an account', intro: 'Use this if someone else may have registered with your Student ID. Note: a counted ballot cannot be identified or removed.',
    fields: [['studentId', 'Student ID', 'text'], ['details', 'What happened?', 'area']], cta: 'Send dispute' },
  report: { title: 'Report a fake site or message', intro: 'Paste the address or message you received. Official links only come from your Electoral Committee.',
    fields: [['url', 'Website address or message', 'text'], ['details', 'Anything else we should know?', 'area']], cta: 'Send report' },
};

const KINDS = Object.keys(COPY) as SupportKind[];
const TAB: Record<SupportKind, string> = { claim: 'Claim account', protest: 'File a protest', dispute: 'Dispute an account', report: 'Report a fake site' };
export const helpPath = (k: SupportKind) => `/help/${k}`;

// One help page for every request to the Electoral Committee; the tab bar switches the form. The old separate addresses redirect here.
export function HelpPage() {
  const { kind } = useParams(); if (!kind) return <Navigate to={helpPath('claim')} replace />; if (!KINDS.includes(kind as SupportKind)) return <Navigate to={helpPath('claim')} replace />;
  return <><nav className="control-row" aria-label="Kinds of help">{KINDS.map((k) => <NavLink key={k} to={helpPath(k)}>{TAB[k]}</NavLink>)}</nav><SupportForm key={kind} kind={kind as SupportKind} /></>;
}
function SupportForm({ kind }: { kind: SupportKind }) {
  const c = COPY[kind];
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setErr(''); setMsg(''); setBusy(true);
    const data = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>;
    const missing = c.fields.some(([n]) => !String(data[n] ?? '').trim());
    try {
      if (!missing && kind === 'claim' && (data.password ?? '').length < 8) { setErr('Use at least 8 characters for your password.'); return; }
      const res = missing ? null : await api.submitSupport(kind, data);
      if (res && res.ok) { setMsg(res.data.message); setDone(true); (event.target as HTMLFormElement).reset(); } else setErr(res ? res.message : GENERIC_FAILURE_MESSAGE);
    } catch { setErr(GENERIC_FAILURE_MESSAGE); } finally { setBusy(false); }
  }
  return <Card className="form-card"><Eyebrow>Electoral Committee</Eyebrow><h1 className="form-title">{c.title}</h1><p className="form-intro">{c.intro}</p>
    {!api.live && <div className="alert-box" style={{ fontSize: 11, marginBottom: 18 }}>Prototype only. Nothing is sent anywhere in mock mode.</div>}
    <form noValidate onSubmit={onSubmit}>{c.fields.map(([n, label, type]) => <div className="field" key={n}><label htmlFor={`s-${n}`}>{label}</label>
      {type === 'area' ? <textarea id={`s-${n}`} name={n} rows={4} required /> : <input id={`s-${n}`} name={n} type={type} required autoComplete={type === 'password' ? 'new-password' : 'off'} />}</div>)}
      {err && <div className="form-message" role="alert">{err}</div>}{msg && <div className="form-message" role="status">{msg}</div>}{done && kind === 'claim' && <p><Link to="/login">Go to sign in</Link></p>}
      <Button className="btn-block" type="submit" disabled={busy}>{busy ? 'Please wait…' : c.cta} <ArrowRight size={16} /></Button></form></Card>;
}
