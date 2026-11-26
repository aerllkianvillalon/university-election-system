import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { MessageCircle, Send, X } from 'lucide-react';
import { api } from '../../lib/api/client';

type Turn = { role: 'user' | 'assistant'; content: string; sources?: { title: string; path: string }[]; error?: boolean };
const SUGGESTIONS = ['How do I vote?', 'I forgot my password', 'Where is my receipt?', 'When does voting close?'];

// A small help assistant. It answers from the Electoral Committee's approved text only, never sees a ballot, and keeps nothing after the tab closes.
export function Assistant() {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const { pathname } = useLocation();
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { void api.assistantEnabled().then(setEnabled); }, []);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [turns, busy]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [open]);
  // Never in the ballot: nothing should interrupt or nudge a voter while they choose.
  if (!enabled || pathname === '/vote') return null;

  async function send(question: string) {
    const q = question.trim(); if (!q || busy) return;
    const next: Turn[] = [...turns.filter((t) => !t.error), { role: 'user', content: q }];
    setTurns(next); setText(''); setBusy(true);
    const r = await api.askAssistant(next.map(({ role, content }) => ({ role, content })));
    setBusy(false);
    setTurns([...next, r.ok ? { role: 'assistant', content: r.text, sources: r.sources } : { role: 'assistant', error: true, content: r.reason === 'busy' ? 'Lots of questions right now. Please wait a minute and try again.' : 'I couldn’t answer that. Please try again, or ask the Electoral Committee.' }]);
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void send(text); };

  return <>
    {!open && <button type="button" className="assistant-fab" onClick={() => setOpen(true)} aria-haspopup="dialog"><MessageCircle size={18} aria-hidden="true"/> Help</button>}
    {open && <section className="assistant" role="dialog" aria-label="Help assistant">
      <header className="assistant-head"><div><strong>Help assistant</strong><span>Answers about using this site. It is not the Electoral Committee.</span></div><button type="button" className="assistant-close" onClick={() => setOpen(false)} aria-label="Close help"><X size={18} aria-hidden="true"/></button></header>
      <div className="assistant-log" role="log" aria-live="polite" ref={log}>
        {turns.length === 0 && <div className="assistant-hello"><p>Hi! Ask me how to register, vote, or check your receipt. I can’t help with who to vote for, and I never see anyone’s ballot.</p><div className="assistant-chips">{SUGGESTIONS.map((s) => <button type="button" key={s} onClick={() => void send(s)}>{s}</button>)}</div></div>}
        {turns.map((t, i) => <div key={i} className={`assistant-msg from-${t.role === 'user' ? 'user' : 'bot'}${t.error ? ' error' : ''}`}><p>{t.content}</p>{t.sources && t.sources.length > 0 && <p className="assistant-src">Read more: {t.sources.map((s, k) => <span key={s.path + k}>{k > 0 && ' · '}<Link to={s.path} onClick={() => setOpen(false)}>{s.title}</Link></span>)}</p>}</div>)}
        {busy && <div className="assistant-msg from-bot" aria-label="Thinking"><p className="assistant-dots"><i/><i/><i/></p></div>}
      </div>
      <p className="assistant-warn">Don’t type your password, voucher or receipt code here.</p>
      <form className="assistant-form" onSubmit={submit}><input ref={input} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="Type your question" aria-label="Your question" autoComplete="off"/><button type="submit" disabled={busy || !text.trim()} aria-label="Send"><Send size={17} aria-hidden="true"/></button></form>
    </section>}
  </>;
}
