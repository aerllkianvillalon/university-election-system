import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ArrowUpRight, BadgeCheck, Bell, Building2, Check, CheckCircle2, ChevronRight, CircleHelp, ClipboardCheck, Clock3, Eye, EyeOff, Fingerprint, Flag, KeyRound, LockKeyhole, LogOut, Menu, MessageCircle, Moon, Monitor, RotateCcw, ShieldCheck, Sun, Users, Vote, X } from 'lucide-react';
import { api } from '../lib/api/client';
import { rankContest } from '../lib/results';
const StaffLogin=lazy(()=>import('../features/staff/StaffPages').then((m)=>({default:m.StaffLogin})));
const StaffSetup=lazy(()=>import('../features/staff/StaffPages').then((m)=>({default:m.StaffSetup})));
const StaffConsole=lazy(()=>import('../features/staff/StaffPages').then((m)=>({default:m.StaffConsole})));
import { GENERIC_FAILURE_MESSAGE, type AdminOverview, type BallotDraft, type Booth, type Candidate, type CertifiedResult, type ResultsProof, type Election, type Organization, type OrganizationElection, type Receipt, type SelectionMap } from '../lib/api/types';
import { ActionLink, Button, CandidateCard, Card, Eyebrow, IconBadge, SectionHeading, StatCard, StatusPill } from '../components/ui/Primitives';
import { HelpPage } from '../features/support/SupportPages';
import heroArt from '../assets/images/campus-ballot-hero.svg';

const labTarget = __TARGET__ === 'lab';
// In-lab voting (kiosk and proctor screens) is a later phase. A live central build leaves those pages out unless VITE_LAB_ENABLED=1; the lab build and the mock demo always have them.
const labPages = labTarget || !api.live || import.meta.env.VITE_LAB_ENABLED === '1';
const orgPalette = ['yellow', 'dark', 'light'] as const;
function electionWindow(election: Election | null) {
  if (!election) return '—';
  const shortDate = (value: string) => value.split(' · ')[0].replace(/, 2026$/, '').replace('October', 'Oct');
  const start = shortDate(election.opensAt);
  const end = shortDate(election.closesAt);
  return start.startsWith('Oct ') && end.startsWith('Oct ')
    ? `Oct ${start.slice(4)}–${end.slice(4)}`
    : `${start}–${end}`;
}

function BrandMark() {
  return <span className="brand-mark"><svg width="25" height="25" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 9h16v11H4zM7 9V5h10v4M8 14l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></span>;
}

function Header({ theme, setTheme, contrast, setContrast }: { theme: 'light' | 'dark'; setTheme: (value: 'light' | 'dark') => void; contrast: boolean; setContrast: (value: boolean) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const navigate = useNavigate();
  useEffect(() => { let on = true; void api.hasSession().then((yes) => { if (on && yes) setLoggedIn(true); });   // a reload keeps the cookie, so ask the server
    const onLogin = () => setLoggedIn(true); window.addEventListener('ctu-demo-login', onLogin); return () => { on = false; window.removeEventListener('ctu-demo-login', onLogin); }; }, []);
  const links = [['/election', 'Election'], ['/candidates', 'Candidates'], ['/status', 'My status'], ['/results', 'Results']];
  async function logOut() { await api.logout(); setLoggedIn(false); navigate('/'); }
  return <header className="topbar"><div className="topbar-inner">
    <Link className="brand" to="/" aria-label="CTU Danao Student Elections home"><BrandMark/><span className="brand-copy"><strong>CTU DANAO</strong><span>STUDENT ELECTIONS</span></span></Link>
    <nav className="nav-links" aria-label="Main navigation">{links.map(([to, label]) => <NavLink key={to} to={to}>{label}</NavLink>)}</nav>
    <div className="nav-actions">
      <button className="icon-button" type="button" aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={18}/> : <Sun size={18}/>}</button>
      <button className="icon-button desktop-only" type="button" aria-pressed={contrast} aria-label="Toggle high contrast" onClick={() => setContrast(!contrast)}><Monitor size={17}/></button>
      {loggedIn ? <button className="btn btn-quiet btn-sm" onClick={logOut}><LogOut size={15}/> Sign out</button> : <ActionLink to="/login" variant="secondary" className="desktop-only">Sign in</ActionLink>}
      <button className="icon-button menu-toggle" aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'} aria-expanded={menuOpen} aria-controls="mobile-navigation" onClick={() => setMenuOpen(!menuOpen)}><Menu size={19}/></button>
    </div>
  </div><nav id="mobile-navigation" className={`nav-mobile ${menuOpen ? 'open' : ''}`} aria-label="Mobile navigation">{links.map(([to, label]) => <NavLink key={to} to={to} onClick={() => setMenuOpen(false)}>{label}</NavLink>)}{loggedIn?<button className="btn btn-quiet" onClick={logOut}><LogOut size={15}/> Sign out</button>:<NavLink to="/login" onClick={() => setMenuOpen(false)}>Sign in</NavLink>}<button className="btn btn-quiet" onClick={() => setContrast(!contrast)}>{contrast ? 'Standard contrast' : 'High contrast'}</button></nav></header>;
}

function Footer() {
  return <footer className="footer"><div className="footer-inner"><div><strong>CTU Danao · Student Elections</strong><div>{api.live ? 'Questions or problems? Contact the Electoral Committee.' : 'Prototype interface · Fictional content · No real vote is submitted'}</div></div><div className="footer-links"><Link to="/legal/privacy">Privacy</Link><Link to="/legal/terms">Terms</Link><Link to="/legal/election-rules">Election rules</Link><Link to="/legal/accessibility">Accessibility</Link><Link to="/protest">File a protest</Link><Link to="/account-dispute">Account dispute</Link><Link to="/claim-account">Claim account</Link><Link to="/report-fake-site">Report a fake site</Link><Link to="/demo/states">System states</Link><Link to="/admin">Admin demo</Link></div></div></footer>;
}

function PageFrame({ children, theme, setTheme, contrast, setContrast }: { children: ReactNode; theme: 'light' | 'dark'; setTheme: (value: 'light' | 'dark') => void; contrast: boolean; setContrast: (value: boolean) => void }) {
  const location = useLocation();
  if (location.pathname === '/lab/booth') return <div className={`site-frame kiosk-frame ${theme === 'dark' ? 'theme-dark' : ''}`}><a className="skip-link" href="#main-content">Skip to kiosk content</a><main className="kiosk-main" id="main-content" tabIndex={-1}>{children}</main></div>;
  return <div className={`site-frame ${theme === 'dark' ? 'theme-dark' : ''}`}><a className="skip-link" href="#main-content">Skip to content</a><Header theme={theme} setTheme={setTheme} contrast={contrast} setContrast={setContrast}/><main className="app-main" id="main-content" tabIndex={-1}>{children}</main><Footer/>{!labTarget && <Chatbot/>}</div>;
}

function Chatbot() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState(['Hi! I can help with election dates, eligibility, and how the ballot works. This demo does not check personal voter records.']);
  function send(event: FormEvent) {
    event.preventDefault();
    if (!question.trim()) return;
    const q = question.trim(); setMessages((old) => [...old, `You: ${q}`, 'Demo assistant: Check the election info and status pages for current mock guidance. For account-specific help, contact the campus election committee.']); setQuestion('');
  }
  return <>
    {open && <section className="chat-panel" role="dialog" aria-modal="false" aria-labelledby="chat-heading"><div className="chat-head"><div><strong id="chat-heading">Election help</strong><div style={{fontSize:11,color:'#d5d5ce'}}>Mock assistant · no personal records</div></div><button className="icon-button" aria-label="Close help dialog" onClick={() => setOpen(false)}><X size={17}/></button></div><div className="chat-body" aria-live="polite">{messages.map((message,index)=><p key={index} className="chat-bubble">{message}</p>)}</div><form className="chat-send" onSubmit={send}><label className="sr-only" htmlFor="chat-question">Ask a question</label><input id="chat-question" value={question} onChange={(event)=>setQuestion(event.target.value)} placeholder="Ask about the process"/><button className="icon-button" aria-label="Send question" type="submit"><ArrowRight size={17}/></button></form></section>}
    <button className="chat-launcher" aria-expanded={open} aria-controls="chat-heading" onClick={()=>setOpen(!open)}><MessageCircle size={20}/><span>Election help</span></button>
  </>;
}

function Home() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [election, setElection] = useState<Election | null>(null);
  useEffect(() => { void api.getOrganizations().then(setOrganizations); void api.getCurrentElection().then(setElection); }, []);
  return <>
    <section className="hero-panel" aria-labelledby="hero-title"><div className="hero-word" aria-hidden="true">VOTE</div><div className="hero-copy"><span className="hero-chip"><span className="status-dot"/>CTU Danao Campus · 2026 cycle</span>
      <h1 id="hero-title">Your voice.<br/>Your <span className="hero-accent">campus.</span></h1>
      <p className="hero-lead">Pick your organization, meet the candidates, and cast your ballot one contest at a time.</p>
      <div className="hero-actions"><ActionLink to="/election">View election <ArrowRight size={16}/></ActionLink><ActionLink to="/candidates" variant="secondary">Meet the candidates</ActionLink></div>
      <div className="hero-badge"><IconBadge><BadgeCheck size={19}/></IconBadge><span><strong>{organizations.length || 3} organizations</strong><br/>{election?.status === 'Open' ? 'Voting is open now' : 'Sample election window'}</span></div>
      {!api.live&&<p className="hero-footnote">Prototype · Mock data only · No real vote is submitted</p>}
    </div><div className="hero-visual"><img className="hero-art" src={heroArt} alt="Line-art campus tower and checked ballot box glowing in electric yellow"/>
      <div className="phone" aria-hidden="true"><div className="phone-bar"><span>9:41</span><span className="phone-notch"/><span>●●●</span></div><div className="phone-body"><small>Contest 1 of 3</small><strong>President</strong><div className="phone-row on"><i>A</i><span>Aya R.<em>Forward</em></span><b>✓</b></div><div className="phone-row"><i>M</i><span>Mika T.<em>Unity</em></span><b/></div><div className="phone-row"><i>R</i><span>Renzo C.<em>Bridge</em></span><b/></div><div className="phone-cta">Next contest</div></div></div>
      <span className="chip chip-a"><ShieldCheck size={15}/>Verified roll</span><span className="chip chip-b"><BadgeCheck size={15}/>Sealed receipt</span><span className="chip chip-c"><Vote size={15}/>One contest at a time</span>
    </div></section>
    <section className="home-section" aria-labelledby="election-overview"><div className="page-head"><div><Eyebrow>Election overview</Eyebrow><h2 id="election-overview" style={{font:'800 clamp(25px,4vw,36px)/1.05 Montserrat,Inter,sans-serif',letterSpacing:'-.04em',margin:'4px 0'}}>Make your <span className="highlight-word">voice count.</span></h2></div><StatusPill tone={election?.status === 'Open' ? 'success' : 'neutral'}>{election?.status ?? 'Loading election'}</StatusPill></div>
      <div className="stats-row"><StatCard label="Organizations" value={organizations.length || '—'} note="One campus · many voices" icon={<Building2 size={17}/>}/><StatCard label="Voting window" value={electionWindow(election)} note={election?.status === 'Open' ? 'Voting is open' : api.live ? 'Campus time' : 'Mock election dates'} icon={<Clock3 size={17}/>}/><StatCard label="Eligible voters" value={api.live ? '—' : election?.totalEligible.toLocaleString() ?? '—'} note="For this organization" icon={<Users size={17}/>}/></div>
    </section>
    <section className="home-section"><SectionHeading eyebrow="Choose your community" title="Every organization." highlight="One clear process." body="Select a student organization to explore its election. Candidate profiles are available before you enter the ballot."/><div className="org-grid">{organizations.map((organization,index)=><Link to={`/election?org=${organization.id}`} className="card org-card" key={organization.id}><IconBadge tone={orgPalette[index]}><Building2 size={19}/></IconBadge><div><h3>{organization.name}</h3><p>{organization.accent}</p></div><ChevronRight className="org-arrow" size={20}/></Link>)}</div>
      <div className="trust-band"><IconBadge><ShieldCheck size={21}/></IconBadge><div><strong>One contest at a time. No surprises.</strong><p>Review each selection before you submit. Candidate totals are never shown during voting.</p></div><ArrowUpRight size={20}/></div>
    </section>
  </>;
}

function ElectionInfo() {
  const [params] = useSearchParams();
  const organizationId = params.get('org') ?? undefined;
  const [context, setContext] = useState<OrganizationElection | null>(null);
  useEffect(() => { void api.getOrganizationElection(organizationId).then(setContext); }, [organizationId]);
  if (!context) return <LoadingPage/>;
  const { election, organization } = context;
  return <><div className="page-head"><div><Eyebrow>{organization.name} · 2026 election</Eyebrow><h1>{organization.name}<span className="highlight-word"> election.</span></h1><p>Everything you need before you make your choice.</p></div><StatusPill tone={election.status === 'Open' ? 'success' : 'warning'}>{election.status}</StatusPill></div>
    <div className="two-col"><Card><Eyebrow>Voting window</Eyebrow><h2 style={{font:'800 24px Montserrat,Inter,sans-serif',margin:'0 0 18px'}}>{election.title}</h2><div className="info-list"><div className="info-row"><IconBadge><Clock3 size={17}/></IconBadge><div><strong>Opens</strong><p>{election.opensAt}</p></div></div><div className="info-row"><IconBadge><Flag size={17}/></IconBadge><div><strong>Closes</strong><p>{election.closesAt}</p></div></div><div className="info-row"><IconBadge><Users size={17}/></IconBadge><div><strong>Who can vote</strong><p>Currently enrolled CTU Danao students on the verified voter roll for {organization.name}.</p></div></div></div><ActionLink to={`/candidates?org=${organization.id}`} variant="secondary">Review candidate profiles <ArrowRight size={15}/></ActionLink></Card>
      <div style={{display:'grid',gap:14}}><Card><IconBadge><ShieldCheck size={19}/></IconBadge><h3 style={{font:'700 19px Montserrat,Inter,sans-serif'}}>A private ballot</h3><p style={{color:'var(--muted)',fontSize:13}}>{api.live?'Your selections are encrypted before they are stored, and your receipt does not show how you voted.':'Your selections are kept private. This prototype stores only an ephemeral mock ballot in this browser session.'}</p></Card><Card><IconBadge><CircleHelp size={19}/></IconBadge><h3 style={{font:'700 19px Montserrat,Inter,sans-serif'}}>Need help?</h3><p style={{color:'var(--muted)',fontSize:13}}>Visit the proctor station or contact the campus election committee if you need assistance.</p><ActionLink to="/legal/election-rules" variant="quiet">Read election rules</ActionLink></Card></div></div>
  </>;
}

function Candidates() {
  const [params] = useSearchParams();
  const organizationId = params.get('org') ?? undefined;
  const [context, setContext] = useState<OrganizationElection | null>(null);
  const [contest, setContest] = useState('all');
  useEffect(() => { void api.getOrganizationElection(organizationId).then(setContext); setContest('all'); }, [organizationId]);
  const contests = context?.election.contests ?? [];
  const candidates = useMemo(() => contests.filter((item) => contest === 'all' || item.id === contest).flatMap((item) => item.candidates), [contests, contest]);
  if (!context) return <LoadingPage/>;
  return <><div className="page-head"><div><Eyebrow>{context.organization.name} · candidate guide</Eyebrow><h1>Meet your <span className="highlight-word">candidates.</span></h1><p>{api.live?'Get to know the candidates on your ballot. No vote totals are shown here.':'Get to know the fictional candidates before you enter the ballot. No vote totals are shown here.'}</p></div><StatusPill tone={context.election.status === 'Open' ? 'success' : 'warning'}>{context.election.status === 'Open' ? 'Profiles open' : 'Election upcoming'}</StatusPill></div>
    <div className="filter-row"><button className={`btn ${contest==='all'?'btn-primary':'btn-quiet'}`} onClick={() => setContest('all')}>All contests</button>{contests.map((item) => <button key={item.id} className={`btn ${contest===item.id?'btn-primary':'btn-quiet'}`} onClick={() => setContest(item.id)}>{item.title}</button>)}</div>
    {api.live&&context.election.signedIn===false?<Card className="empty-state"><IconBadge><LockKeyhole size={20}/></IconBadge><h2>Sign in to see your candidates.</h2><p>Your ballot depends on your program and year, so the candidate list is shown after you sign in.</p><ActionLink to="/login">Sign in <ArrowRight size={15}/></ActionLink></Card>:<div className="candidate-grid">{candidates.map((candidate) => <CandidateCard candidate={candidate} key={candidate.id}/>)}</div>}
    <div style={{display:'flex',justifyContent:'center',marginTop:28}}><ActionLink to={`/vote?org=${context.organization.id}`}>Enter the ballot <ArrowRight size={16}/></ActionLink></div>
  </>;
}

function AuthPage({ mode }: { mode: 'register' | 'login' | 'forgot' | 'reset' }) {
  const [showPassword,setShowPassword]=useState(false); const [message,setMessage]=useState(''); const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
  // Reset link: the token is read once, taken out of the address bar (history, screenshots, Referer), and checked without being used up.
  const [resetToken]=useState(()=>mode==='reset'?new URLSearchParams(window.location.search).get('token')??'':'');
  const [link,setLink]=useState<'checking'|'valid'|'invalid'>(mode==='reset'?'checking':'valid'); const [resetDone,setResetDone]=useState(false);
  useEffect(()=>{if(mode!=='reset')return;if(resetToken)window.history.replaceState(null,'',window.location.pathname);let on=true;
    void (api.live&&!resetToken?Promise.resolve(false):api.checkResetLink(resetToken)).then((valid)=>{if(on)setLink(valid?'valid':'invalid');});return()=>{on=false;};},[mode,resetToken]);
  const title={register:'Create your voter account',login:'Sign in to your account',forgot:'Reset your password',reset:'Choose a new password'}[mode];
  const description={register:'Use your student ID and election voucher to get started.',login:'Access your voting status and ballot.',forgot:'We’ll share the next step without confirming whether an account exists.',reset:api.live?'Create a new password for your account.':'Create a new password for your demo account.'}[mode];
  async function handleSubmit(event:FormEvent<HTMLFormElement>){event.preventDefault();setError('');setMessage('');setBusy(true);const form=new FormData(event.currentTarget);const password=String(form.get('password')||'');
    try {
      if(mode==='register'){
        const accepted=form.get('terms')==='on'; const studentId=String(form.get('studentId')||''); const voucher=String(form.get('voucher')||'');
        if(!studentId||!voucher||password.length<8||!accepted) throw new Error(GENERIC_FAILURE_MESSAGE);
        const result=await api.register({studentId,voucher,password,termsAccepted:accepted});if(!result.ok)throw new Error(api.genericFailure());window.dispatchEvent(new Event('ctu-demo-login'));setMessage(api.live?'Your account is ready and you are signed in.':'Your demo account is ready. You can now review your voter status.');
      } else if(mode==='login'){
        const identifier=String(form.get('identifier')||'');if(!identifier||password.length<8)throw new Error(GENERIC_FAILURE_MESSAGE);
        const result=await api.authenticate({identifier,password});if(!result.ok)throw new Error(api.genericFailure());window.dispatchEvent(new Event('ctu-demo-login'));setMessage(api.live?'You’re signed in.':'You’re signed in to the demo. Your ballot selections are still private.');
      } else if(mode==='forgot'){
        const identifier=String(form.get('identifier')||'');if(!identifier)throw new Error(GENERIC_FAILURE_MESSAGE);const result=await api.requestPasswordReset(identifier);if(!result.ok)throw new Error(api.genericFailure());setMessage(result.data.message);
      } else {
        if(password.length<8){setError('Use at least 8 characters for your password.');return;}
        if(password!==String(form.get('confirm')||'')){setError('The two passwords do not match.');return;}
        const result=await api.resetPassword(resetToken,password);if(!result.ok){setError(result.message);return;}setResetDone(true);setMessage(result.data.message);
      }
    }catch{setError(GENERIC_FAILURE_MESSAGE);}finally{setBusy(false);}
  }
  return <Card className="form-card"><Eyebrow>Secure student access</Eyebrow><h1 className="form-title">{title}</h1><p className="form-intro">{description}</p>{!api.live&&<div className="alert-box" style={{fontSize:11,marginBottom:18}}>Prototype only. Do not enter a real password or voucher.</div>}
    {mode==='reset'&&link==='checking'&&<p role="status">Checking your link…</p>}
    {mode==='reset'&&link==='invalid'&&<div className="form-message" role="alert">This link is no longer valid. It may have expired or already been used. <Link to="/forgot-password">Request a new link</Link>.</div>}
    {!(mode==='reset'&&link!=='valid')&&<form noValidate onSubmit={handleSubmit}>
      {mode==='register'&&<><div className="field"><label htmlFor="student-id">Student ID</label><input id="student-id" name="studentId" required autoComplete="username" placeholder="e.g. 2026-00001"/></div><div className="field"><label htmlFor="voucher">Election voucher</label><input id="voucher" name="voucher" required autoComplete="off" placeholder="e.g. DANAO-2026-DEMO"/></div></>}
      {mode!=='reset'&&mode!=='register'&&<div className="field"><label htmlFor="identifier">{api.live?'Student ID':mode==='forgot'?'Student ID or email':'Student ID or campus email'}</label><input id="identifier" name="identifier" required autoComplete="username" placeholder={api.live?'Enter your student ID':'Enter your student ID or email'}/></div>}
      {mode!=='forgot'&&<div className="field"><label htmlFor="password">{mode==='reset'?'New password':'Password'}</label><div style={{position:'relative'}}><input id="password" name="password" type={showPassword?'text':'password'} required minLength={8} autoComplete={mode==='register'||mode==='reset'?'new-password':'current-password'} placeholder="At least 8 characters" style={{paddingRight:58}}/><button type="button" aria-label={showPassword?'Hide password':'Show password'} className="icon-button" style={{position:'absolute',right:4,top:1,width:48,height:48,border:0,background:'transparent'}} onClick={()=>setShowPassword(!showPassword)}>{showPassword?<EyeOff size={17}/>:<Eye size={17}/>}</button></div><small>Use at least 8 characters. Never share your password.</small></div>}
      {mode==='reset'&&<div className="field"><label htmlFor="confirm">Confirm new password</label><input id="confirm" name="confirm" type={showPassword?'text':'password'} required minLength={8} autoComplete="new-password"/></div>}
      {mode==='register'&&<label className="checkline"><input type="checkbox" name="terms" required/><span>I agree to the <Link to="/legal/terms">Terms of Use</Link> and acknowledge the privacy notice.</span></label>}
      {error&&<div className="form-message" role="alert">{error}</div>}{message&&<div className="form-message" role="status">{message}</div>}
      <Button className="btn-block" type="submit" disabled={busy||resetDone}>{busy?'Please wait…':mode==='register'?(api.live?'Create account':'Create demo account'):mode==='login'?'Sign in':mode==='forgot'?'Send instructions':'Update password'} <ArrowRight size={16}/></Button>
    </form>}
    <div className="form-links">{mode==='login'?<><Link to="/forgot-password">Forgot password?</Link><Link to="/register">Create voter account</Link></>:mode==='register'?<Link to="/login">Already registered? Sign in</Link>:mode==='forgot'?<Link to="/login">Back to sign in</Link>:<Link to="/login">Return to sign in</Link>}</div>
  </Card>;
}

function StatusPage() {
  const [params]=useSearchParams();const organizationId=params.get('org')??undefined;
  const [status,setStatus]=useState<{eligible:boolean;ballot:'not-started'|'voted';message:string;signedIn?:boolean}|null>(null);const [context,setContext]=useState<OrganizationElection|null>(null);
  useEffect(()=>{void api.getStatus().then(setStatus);void api.getOrganizationElection(organizationId).then(setContext);},[organizationId]);
  return <><div className="page-head"><div><Eyebrow>Voter status</Eyebrow><h1>Your status, <span className="highlight-word">at a glance.</span></h1><p>{api.live?'Check whether your ballot has been recorded.':'Check your mock eligibility and ballot status. This prototype is not connected to the official voter roll.'}</p></div></div>
    {!status||!context?<LoadingPage/>:<div className="two-col"><Card><StatusPill tone={status.signedIn===false?'warning':'success'}>{status.signedIn===false?'Sign in required':status.eligible?'Eligible to vote':'Not eligible'}</StatusPill><h2 style={{font:'800 26px Montserrat,Inter,sans-serif',margin:'20px 0 4px'}}>{context.election.title}</h2><p style={{color:'var(--muted)',fontSize:13}}>{status.message}</p><div className="info-list"><div className="info-row"><IconBadge><CheckCircle2 size={18}/></IconBadge><div><strong>Voter roll</strong><p>{api.live?(status.signedIn===false?'Sign in to check your record.':'You are on the voter roll for this election.'):'Mock record verified for this demonstration.'}</p></div></div><div className="info-row"><IconBadge><Vote size={18}/></IconBadge><div><strong>Ballot</strong><p>{status.ballot==='voted'?'Submitted · verification in progress':'Not yet submitted'}</p></div></div></div>{status.signedIn===false?<ActionLink to="/login">Sign in <ArrowRight size={16}/></ActionLink>:status.ballot==='not-started'?<ActionLink to={`/vote?org=${context.organization.id}`}>Enter ballot <ArrowRight size={16}/></ActionLink>:<ActionLink to="/receipt" variant="quiet">View receipt</ActionLink>}</Card><Card><IconBadge><LockKeyhole size={19}/></IconBadge><h3 style={{font:'700 19px Montserrat,Inter,sans-serif'}}>Your choice stays private</h3><p style={{fontSize:13,color:'var(--muted)'}}>Only an aggregate participation status appears here. Candidate-level results remain hidden until an election is certified.</p></Card></div>}
  </>;
}

// Certified counts for one contest. Winners are deliberately NOT declared: the winner and tie rules are an election-committee decision.
function ContestCounts({result}:{result:CertifiedResult}){
  const seats=result.seats??1, {rows,tie,short}=rankContest(result.candidates??[],seats);
  return <Card><Eyebrow>Certified count</Eyebrow><h2 style={{font:'800 22px Montserrat,Inter,sans-serif',margin:'0 0 12px'}}>{result.title}</h2>
    <table className="results-table"><caption className="sr-only">Votes for {result.title}. {seats===1?'One seat.':`${seats} seats.`}</caption>
      <thead><tr><th scope="col">Candidate</th><th scope="col" className="num">Votes</th><th scope="col">Standing</th></tr></thead>
      <tbody>{rows.map((c)=><tr key={c.id}><th scope="row">{c.name}</th><td className="num">{c.votes.toLocaleString()}</td><td>{c.standing}</td></tr>)}
        <tr><th scope="row">Abstained</th><td className="num">{(result.abstain??0).toLocaleString()}</td><td></td></tr></tbody></table>
    {short&&<div className="alert-box" role="note" style={{marginTop:12,fontSize:12}}>{seats===1?'No candidate received votes.':'Fewer candidates received votes than there are seats.'} The election rules decide what happens next.</div>}
    {tie&&<div className="alert-box" role="note" style={{marginTop:12,fontSize:12}}>Tied for the last seat. The election rules decide how this is resolved; no winner is declared here.</div>}
    <p style={{color:'var(--muted)',fontSize:11}}>Certified {result.certifiedAt}</p></Card>;
}
function ResultsPage() {
  const [electionId,setElectionId]=useState('election-current');const [results,setResults]=useState<CertifiedResult[]|null>(null);const [locked,setLocked]=useState(true);const [proof,setProof]=useState<ResultsProof|null>(null);
  async function load(id:string){setElectionId(id);setResults(null);const response=await api.getResults(id);if(response.ok){setLocked(false);setResults(response.data);setProof(api.getResultsProof());}else{setLocked(true);setResults([]);setProof(null);}}
  useEffect(()=>{void load('election-current');},[]);
  return <><div className="page-head"><div><Eyebrow>Election archive</Eyebrow><h1>Results with <span className="highlight-word">integrity.</span></h1><p>Results are published only after a formal certification decision.</p></div><StatusPill tone={locked?'warning':'success'}>{locked?'Awaiting certification':'Certified'}</StatusPill></div>
    <div className="filter-row"><Button variant={electionId==='election-current'?'primary':'quiet'} onClick={()=>void load('election-current')}>Current election</Button>{!api.live&&<Button variant={electionId==='archive-2025'?'primary':'quiet'} onClick={()=>void load('archive-2025')}>Certified archive · 2025</Button>}</div>
    {locked?<Card className="empty-state"><IconBadge><LockKeyhole size={20}/></IconBadge><h2>Results are not available yet.</h2><p>Candidate-level results are withheld until independent certification is complete.</p><StatusPill tone="warning">Not certified</StatusPill></Card>:<><div className="admin-grid">{results?.map((result)=>result.candidates?<ContestCounts key={result.contestId} result={result}/>:<Card key={result.contestId}><Eyebrow>Certified outcome</Eyebrow><h2 style={{font:'800 22px Montserrat,Inter,sans-serif',margin:'0 0 12px'}}>{result.title}</h2><ul style={{paddingLeft:19}}>{result.winners.map((winner)=><li key={winner} style={{margin:'8px 0',fontWeight:700}}>{winner}</li>)}</ul><p style={{color:'var(--muted)',fontSize:11}}>Certified {result.certifiedAt} · Sample archive data</p></Card>)}</div>{proof&&<Card style={{marginTop:18}}><h2 style={{font:'800 18px Montserrat,Inter,sans-serif',margin:'0 0 8px'}}>{proof.ballots.toLocaleString()} ballots counted</h2><p style={{color:'var(--muted)',fontSize:13}}>These counts were signed after the tally and checked against the sealed ballots before they were certified. You can check them yourself.</p>
      <details><summary>How to check these counts</summary><p style={{fontSize:13}}>Save each signed tally below, together with the signing key, and run <code>ev verify-results</code>. The signing key fingerprint is <strong>{proof.signingKeyFingerprint}</strong>; it should match the one announced at the key ceremony.</p>
        <p style={{fontSize:12,margin:'8px 0 4px'}}>Signing key</p><pre className="proof" tabIndex={0} aria-label="Signing key">{proof.signingKey}</pre>
        {proof.sets.map((set)=><div key={set.chain}><p style={{fontSize:12,margin:'8px 0 4px'}}>Signed tally, chain {set.chain}</p><pre className="proof" tabIndex={0} aria-label={`Signed tally for chain ${set.chain}`}>{JSON.stringify({body:set.body,signature:set.signature},null,2)}</pre></div>)}</details></Card>}</>}
  </>;
}

function Ballot() {
  const navigate=useNavigate();const [params]=useSearchParams();const organizationId=params.get('org')??undefined;const [context,setContext]=useState<OrganizationElection|null>(null);const election=context?.election??null;const [draft,setDraft]=useState<BallotDraft>(()=>api.getDraft());const [step,setStep]=useState(0);const [review,setReview]=useState(false);const [error,setError]=useState('');const [secondsLeft,setSecondsLeft]=useState(()=>Math.max(0,Math.floor((api.getDraft().expiresAt-Date.now())/1000)));
  useEffect(()=>{void api.getOrganizationElection(organizationId).then((next)=>{setContext(next);const current=api.getDraft(next.election.id);setDraft(current);setSecondsLeft(Math.max(0,Math.floor((current.expiresAt-Date.now())/1000)));setStep(0);setReview(false);setError('');});},[organizationId]);
  useEffect(()=>{const timer=window.setInterval(()=>{const left=Math.max(0,Math.floor((draft.expiresAt-Date.now())/1000));setSecondsLeft(left);if(left===0){api.clearBallot('expiry',election?.id);setDraft({electionId:election?.id??'election-current',selections:{},expiresAt:Date.now()});setError('Your ballot session expired. Your selections were cleared. Start again when you’re ready.');window.clearInterval(timer);}},1000);return()=>window.clearInterval(timer);},[draft.expiresAt,election?.id]);
  if(!election)return <LoadingPage/>;
  if(api.live&&election.signedIn===false)return <Card className="empty-state"><IconBadge><LockKeyhole size={20}/></IconBadge><h2>Sign in to vote.</h2><p>Your ballot is prepared for you after you sign in.</p><ActionLink to="/login">Sign in <ArrowRight size={15}/></ActionLink></Card>;
  if(election.contests.length===0)return <Card className="empty-state"><IconBadge><CircleHelp size={20}/></IconBadge><h2>There is nothing to vote on for you.</h2><p>No contests are open to you in this election. If you think this is a mistake, contact the Electoral Committee.</p><ActionLink to="/status" variant="secondary">Check my status</ActionLink></Card>;
  const activeElection=election;const contests=activeElection.contests;const contest=contests[step];const chosen=draft.selections[contest?.id]||[];
  function store(next:SelectionMap){api.saveSelections(next,activeElection.id);setDraft(api.getDraft(activeElection.id));setError('');}
  function toggle(candidate:Candidate){const previous=draft.selections[contest.id]||[];const old=previous.includes('abstain')?[]:previous;let updated:string[];if(old.includes(candidate.id))updated=old.filter((id)=>id!==candidate.id);else if(contest.seats===1)updated=[candidate.id];else if(old.length>=contest.seats){setError(`Choose no more than ${contest.seats} candidates for this contest.`);return;}else updated=[...old,candidate.id];store({...draft.selections,[contest.id]:updated});}
  function abstain(checked:boolean){store({...draft.selections,[contest.id]:checked?['abstain']:[]});}
  async function submit(){try{const receipt=await api.submitBallot(activeElection.id);navigate('/receipt',{state:{receipt,organizationId:activeElection.organizationId}});}catch(cause){setError(cause instanceof Error?cause.message:GENERIC_FAILURE_MESSAGE);}}
  if(secondsLeft===0&&error.startsWith('Your ballot session expired')) return <Card className="empty-state"><IconBadge><Clock3 size={20}/></IconBadge><h2>Ballot session expired.</h2><p>{api.live?'Your selections have been cleared. Nothing was submitted.':'Your selections have been cleared from this demo session.'}</p><Button onClick={()=>{api.saveSelections({},activeElection.id);setDraft(api.getDraft(activeElection.id));setSecondsLeft(600);setStep(0);setReview(false);setError('');}}>Restart ballot</Button></Card>;
  if(review)return <section className="vote-layout"><Eyebrow>Review before you submit</Eyebrow><h1 style={{font:'800 clamp(34px,6vw,54px)/1 Montserrat,Inter,sans-serif',letterSpacing:'-.06em'}}>Your choices.<br/><span className="highlight-word">Your final check.</span></h1><p style={{color:'var(--muted)'}}>Take a moment to review each contest. Submission cannot be undone in a live election.</p><div className="review-list">{contests.map((item,index)=>{const ids=draft.selections[item.id]||[];const names=ids.includes('abstain')?['Abstain']:item.candidates.filter((person)=>ids.includes(person.id)).map((person)=>person.name);return <Card className="review-item" key={item.id}><div><Eyebrow>Contest {index+1}</Eyebrow><strong>{item.title}</strong><p>{names.join(', ')||'No selection'}</p></div><Button variant="quiet" onClick={()=>{setStep(index);setReview(false);}}>Edit</Button></Card>;})}</div><div className="alert-box alert-warning review-warning" role="note">{api.live?<><strong>Important:</strong> Submitting your ballot is final. You cannot change it or vote again.</>:<><strong>Important:</strong> In a live election, submitting your ballot is irreversible. This is a mock demonstration; no real vote is recorded.</>}</div>{error&&<div className="form-message" role="alert">{error}</div>}<div className="vote-sticky"><Button variant="quiet" onClick={()=>setReview(false)}><ArrowLeft size={16}/> Back to ballot</Button><Button onClick={()=>void submit()}>{api.live?'Submit my ballot':'Confirm mock ballot'} <Check size={17}/></Button></div></section>;
  return <section className="vote-layout"><div className="vote-top"><div><Eyebrow>{api.live?'Private ballot':'Private ballot · mock data'}</Eyebrow><strong style={{fontSize:13}}>Contest {step+1} of {contests.length}</strong></div><StatusPill tone={secondsLeft<60?'warning':'neutral'}><Clock3 size={13}/> {Math.floor(secondsLeft/60)}:{String(secondsLeft%60).padStart(2,'0')}</StatusPill></div><div className="progress-track" role="progressbar" aria-label="Ballot progress" aria-valuemin={0} aria-valuemax={contests.length} aria-valuenow={step+1}><div className="progress-fill" style={{width:`${((step+1)/contests.length)*100}%`}}/></div>
    <div className="vote-contest" key={contest.id}><div style={{marginTop:22}}><Eyebrow>{activeElection.title}</Eyebrow><h1>{contest.title}</h1><p className="vote-sub">{contest.description}</p>{contest.seats>1&&<StatusPill tone="warning">Select up to {contest.seats} · {chosen.filter((id)=>id!=='abstain').length} selected</StatusPill>}</div>
      <div className="vote-grid">{contest.candidates.map((candidate)=><CandidateCard key={candidate.id} candidate={candidate} selectable selected={chosen.includes(candidate.id)} onClick={()=>toggle(candidate)}/>)}</div>
      {contest.allowAbstain!==false&&<label className="abstain-card"><input type="checkbox" checked={chosen.includes('abstain')} onChange={(event)=>abstain(event.target.checked)}/><span><strong>Abstain from this contest</strong><br/><small style={{color:'var(--muted)',fontWeight:400}}>Leave this position blank and continue.</small></span></label>}
    </div>
    {error&&<div className="form-message" role="alert">{error}</div>}
    <div className="vote-sticky"><Button variant="quiet" onClick={()=>{setError('');if(step===0)navigate(`/election?org=${activeElection.organizationId}`);else setStep(step-1);}}><ArrowLeft size={16}/> Back</Button><span className="vote-count">Selections stay in this session only.</span>{step<contests.length-1?<Button onClick={()=>{if(!chosen.length){setError('Choose a candidate or abstain before continuing.');return;}setError('');setStep(step+1);}} disabled={!chosen.length}>Next contest <ArrowRight size={16}/></Button>:<Button onClick={()=>{if(!chosen.length){setError('Choose a candidate or abstain before continuing.');return;}setError('');setReview(true);}}>Review ballot <ClipboardCheck size={16}/></Button>}</div>
  </section>;
}

function ReceiptPage() {
  const navigate=useNavigate();const [receipt,setReceipt]=useState<Receipt|null>(()=>api.getReceipt());
  useEffect(()=>{if(!receipt||receipt.state==='sealed')return;let tries=0;const timer=window.setInterval(()=>{tries+=1;const next=api.sealReceipt();if(next&&next.state!==receipt.state)setReceipt(next);if(tries>=60)window.clearInterval(timer);},api.live?5000:1600);return()=>window.clearInterval(timer);},[receipt?.state]);   // live: the sealer runs on its own schedule, so poll until it has
  if(!receipt)return <Card className="empty-state"><IconBadge><Vote size={20}/></IconBadge><h2>No receipt in this session.</h2><p>{api.live?'Your receipt appears here after you submit your ballot. If you already voted, check your status.':'Complete the mock ballot to see its receipt here.'}</p><Button onClick={()=>navigate('/vote')}>Go to ballot <ArrowRight size={16}/></Button></Card>;
  return <Card className="receipt"><div className="receipt-seal"><Check size={38} strokeWidth={3}/></div><StatusPill tone="success">{receipt.state==='recorded'?'Recorded':'Sealed'}</StatusPill><h1 style={{marginTop:17}}>Your ballot is <span className="highlight-word">{receipt.state}.</span></h1><p style={{color:'var(--muted)'}}>We are checking your vote. Your ballot selections are not included in this receipt.</p><div className={`receipt-status ${receipt.state}`}>{receipt.state==='recorded'?'Recorded · verification pending':'Sealed · confirmation complete'}</div><div className="receipt-hash"><span style={{display:'block',color:'var(--muted)',fontFamily:'Inter',marginBottom:5}}>{api.live?'RECEIPT CODE':'DEMO RECEIPT HASH'}</span>{receipt.hash}</div><p style={{fontSize:11,color:'var(--muted)'}}>Reference {receipt.id} · {receipt.recordedAt}<br/>{api.live?'Keep this code. It lets you check that your ballot was recorded, and it does not reveal your choices.':'Mock receipt only; no real vote was submitted.'}</p><div style={{display:'flex',justifyContent:'center',gap:9,flexWrap:'wrap',marginTop:22}}><ActionLink to="/status" variant="secondary">Check status</ActionLink><ActionLink to="/" variant="quiet">Return home</ActionLink></div></Card>;
}

function BoothKiosk() {
  const [state,setState]=useState<'idle'|'waiting'|'wizard'|'auto-reset'>('idle');const [seconds,setSeconds]=useState(45);
  useEffect(()=>{if(state!=='wizard')return;const timer=window.setInterval(()=>setSeconds((value)=>{if(value<=1){api.clearBallot('kiosk-reset');setState('auto-reset');window.clearInterval(timer);return 0;}return value-1;}),1000);return()=>window.clearInterval(timer);},[state]);
  function reset(){api.clearBallot('kiosk-reset');setState('idle');setSeconds(45);}
  const titles={idle:'Your vote. Your voice.',waiting:'You’re checked in.',wizard:'Take your time.', 'auto-reset':'Booth reset.'};
  const descriptions={idle:'A private voting booth is ready when you are.',waiting:'Your demo check-in is complete. The proctor can direct you to an open booth.',wizard:'Your mock session will reset after a short period of inactivity.', 'auto-reset':'Your session ended and ballot selections have been cleared.'};
  return <div className="booth-screen"><div className="booth-inner"><div className="booth-idle-mark"><BrandMark/></div><Eyebrow>CTU Danao · Secure voting booth demo</Eyebrow><h1>{titles[state]}</h1><p>{descriptions[state]}</p>{state==='wizard'&&<div style={{margin:'22px auto',maxWidth:400}}><StatusPill tone="warning"><Clock3 size={13}/> Auto reset in {seconds}s</StatusPill><div className="info-row" style={{textAlign:'left',marginTop:22}}><IconBadge><Vote size={18}/></IconBadge><div><strong>Ballot wizard</strong><p>Use your private one-contest-at-a-time ballot. Selections clear when this booth resets.</p></div></div><ActionLink to="/vote">Continue to mock ballot <ArrowRight size={16}/></ActionLink></div>}{state==='idle'&&<Button onClick={()=>setState('waiting')}>Start check-in <ArrowRight size={17}/></Button>}{state==='waiting'&&<div style={{display:'flex',gap:10,justifyContent:'center',flexWrap:'wrap'}}><Button onClick={()=>setState('wizard')}>Enter assigned booth</Button><Button variant="quiet" onClick={reset}>Cancel</Button></div>}{state==='auto-reset'&&<Button onClick={reset}>Ready for next voter <RotateCcw size={16}/></Button>}<div className="kiosk-footer">Prototype only · Please contact the proctor for accessibility support</div></div></div>;
}

function ProctorStation() {
  const [params]=useSearchParams();const [organizations,setOrganizations]=useState<Organization[]>([]);const [selectedOrganization,setSelectedOrganization]=useState(params.get('org')??'student-council');
  const [booths,setBooths]=useState<Booth[]>([]);const [overview,setOverview]=useState<AdminOverview|null>(null);const [studentId,setStudentId]=useState('');const [message,setMessage]=useState('');const [alarmDismissed,setAlarmDismissed]=useState(false);
  useEffect(()=>{void api.getOrganizations().then(setOrganizations);},[]);
  useEffect(()=>{void api.getBooths(selectedOrganization).then(setBooths);void api.getAdminOverview(selectedOrganization).then(setOverview);setAlarmDismissed(false);},[selectedOrganization]);
  function checkin(event:FormEvent){event.preventDefault();if(!studentId.trim()){setMessage('Enter a student ID to check in this demo.');return;}setMessage('Check-in confirmed for this demo. A mock booth assignment is ready.');setStudentId('');}
  const activeAlarm=(overview?.attentionCount??0)>0&&!alarmDismissed;
  const attentionBooth=booths.find((booth)=>booth.state==='Needs attention');
  const turnoutRate=overview?Math.round((overview.turnout/Math.max(overview.eligible,1))*100):null;
  return <><div className="page-head"><div><Eyebrow>Lab operations · proctor</Eyebrow><h1>Keep the line <span className="highlight-word">moving.</span></h1><p>Check-in, monitor booth availability, and respond to service alerts. Only aggregate participation is displayed.</p></div><StatusPill tone="success">Station online</StatusPill></div>
    <div className="admin-grid"><Card><Eyebrow>Student check-in</Eyebrow><h2 style={{font:'700 21px Montserrat,Inter,sans-serif'}}>Verify access</h2><div className="field"><label htmlFor="proctor-org">Organization election</label><select id="proctor-org" value={selectedOrganization} onChange={(event)=>{setSelectedOrganization(event.target.value);setMessage('');}}>{organizations.map((organization)=><option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></div><form onSubmit={checkin}><div className="field"><label htmlFor="proctor-id">Student ID</label><input id="proctor-id" value={studentId} onChange={(event)=>setStudentId(event.target.value)} placeholder="Enter student ID" autoComplete="off"/></div><Button type="submit">Check in student <Fingerprint size={16}/></Button></form>{message&&<p className="form-message" role="status">{message}</p>}</Card><Card><Eyebrow>Aggregate only</Eyebrow><div className="stats-row"><StatCard label="Checked in" value={overview?.checkedIn??'—'} note="This session"/><StatCard label="Turnout" value={turnoutRate===null?'—':`${turnoutRate}%`} note="Across this election"/></div><p style={{fontSize:11,color:'var(--muted)',marginBottom:0}}>Candidate-level vote counts are never shown at the proctor station.</p></Card></div>
    <section className="home-section"><div className="page-head"><div><Eyebrow>Booth board</Eyebrow><h2 style={{font:'800 28px Montserrat,Inter,sans-serif',margin:0}}>Station status</h2></div><Button variant="quiet" onClick={()=>setBooths([...booths])}><RotateCcw size={15}/> Refresh</Button></div><div className="booth-grid">{booths.map((booth)=><Card className="booth-card" key={booth.id}><Eyebrow>Booth {booth.number}</Eyebrow><StatusPill tone={booth.state==='Available'?'success':booth.state==='Needs attention'?'alert':'warning'}>{booth.state}</StatusPill><p>{booth.voter}</p><strong>{booth.elapsed}</strong><small style={{color:'var(--muted)'}}>session time</small><div style={{display:'flex',gap:7,marginTop:14}}><Button variant="quiet" className="btn-sm" onClick={()=>setMessage(`Booth ${booth.number} issued a demo session.`)}><KeyRound size={14}/> Issue</Button><Button variant="quiet" className="btn-sm" onClick={()=>setMessage(`Booth ${booth.number} demo session cancelled.`)}><X size={14}/> Cancel</Button></div></Card>)}</div></section>
    <Card style={{borderColor:activeAlarm?'var(--yellow)':'var(--line)'}}><div style={{display:'flex',alignItems:'center',gap:12}}><IconBadge><Bell size={19}/></IconBadge><div style={{flex:1}}><strong>Station alarms</strong><p style={{margin:'3px 0 0',fontSize:12,color:'var(--muted)'}}>{activeAlarm?`Booth ${attentionBooth?.number??'—'} requires attention. Please check the kiosk before assigning the next student.`:'No active station alarms.'}</p></div><Button variant={activeAlarm?'primary':'quiet'} onClick={()=>setAlarmDismissed(!alarmDismissed)} disabled={!overview?.attentionCount}>{activeAlarm?'Acknowledge':'Restore alert'}</Button></div></Card>
  </>;
}

const legalContent:Record<string,{title:string;intro:string;sections:[string,string][]}>={
  privacy:{title:'Privacy notice',intro:'This sample privacy page explains the demo boundary. It is not an official CTU privacy statement.',sections:[['Mock data only','This frontend prototype does not verify student identity, access an official voter roll, or submit ballots to an election system.'],['Ballot storage','Draft selections are confined to in-memory and session-scoped demo state and cleared on submit, expiry, sign-out, and booth reset.'],['Backend requirements','Before live use, an authorized service must enforce eligibility, secrecy, auditability, retention, and applicable data protection requirements.']]},
  terms:{title:'Terms of use',intro:'These sample terms accompany a frontend-only demonstration and are not legal advice.',sections:[['Use of this demo','Do not enter actual credentials, student IDs, vouchers, or election selections. Interactions are simulated.'],['Accessibility and conduct','Use the demo respectfully and contact the election committee for official assistance.'],['No official result','Demo receipts and certified archive content are fictional examples and do not establish any election outcome.']]},
  'election-rules':{title:'Election rules',intro:'Sample election information. Official rules must be published and approved by the campus election committee.',sections:[['Eligibility','Live eligibility must be checked against an approved, current voter roll by an authorized backend.'],['Ballot choices','A live ballot must validate seat limits and abstentions server-side and must not disclose individual selections.'],['Certification','Results become public only after the authorized certification and challenge process is complete.']]},
  accessibility:{title:'Accessibility statement',intro:'This prototype is designed around keyboard access, clear focus, high contrast, reduced motion, and touch-friendly targets.',sections:[['Support','For an official election, provide a human assistance channel and accessible in-person voting path.'],['Feedback','Contact the campus election committee with an accessibility concern. No message is sent from this prototype.'],['Review','A production implementation requires route-by-route accessibility testing and assistive technology review.']]},
};
function LegalPage(){const {slug=''}=useParams();const content=legalContent[slug];if(!content) return <NotFound/>;return <article className="legal"><nav className="control-row" aria-label="Policies">{Object.entries(legalContent).map(([k,v])=><NavLink key={k} to={`/legal/${k}`}>{v.title}</NavLink>)}</nav><div className="page-head"><div><Eyebrow>CTU Danao · sample policy</Eyebrow><h1>{content.title}<span className="highlight-word">.</span></h1><p>{content.intro}</p></div></div><Card>{content.sections.map(([title,body])=><section key={title}><h2>{title}</h2><p>{body}</p></section>)}</Card></article>;}
function LoadingPage(){return <section className="card empty-state" aria-live="polite"><div className="skeleton" style={{width:150,margin:'auto'}}/><div className="skeleton" style={{width:'66%',margin:'12px auto'}}/><p>{api.live?'Loading…':'Loading mock election data…'}</p></section>;}
function NotFound(){return <Card className="empty-state"><IconBadge><CircleHelp size={20}/></IconBadge><h2>We can’t find that page.</h2><p>Try returning to the election overview.</p><ActionLink to="/">Back to home <ArrowRight size={15}/></ActionLink></Card>;}

export function App(){
  const routerLocation=useLocation();
  const [theme,setTheme]=useState<'light'|'dark'>('light');const [contrast,setContrast]=useState(false);
  useEffect(()=>{document.documentElement.dataset.theme=theme==='dark'?'dark':'light';document.documentElement.dataset.contrast=contrast?'high':'standard';document.documentElement.style.colorScheme=theme;},[theme,contrast]);
  if(labTarget&&routerLocation.pathname==='/') return <Navigate to="/lab/booth" replace/>;
  return <PageFrame theme={theme} setTheme={setTheme} contrast={contrast} setContrast={setContrast}><Routes>
    <Route path="/" element={<Home/>}/><Route path="/election" element={<ElectionInfo/>}/><Route path="/candidates" element={<Candidates/>}/>
    <Route path="/register" element={<AuthPage mode="register"/>}/><Route path="/login" element={<AuthPage mode="login"/>}/><Route path="/forgot-password" element={<AuthPage mode="forgot"/>}/><Route path="/reset-password" element={<AuthPage mode="reset"/>}/>
    <Route path="/status" element={<StatusPage/>}/><Route path="/results" element={<ResultsPage/>}/><Route path="/vote" element={<Ballot/>}/><Route path="/receipt" element={<ReceiptPage/>}/>
    {labPages&&<><Route path="/lab/booth" element={<BoothKiosk/>}/><Route path="/lab/proctor" element={<ProctorStation/>}/></>}<Route path="/admin" element={<Navigate to="/staff" replace/>}/><Route path="/staff/login" element={<Suspense fallback={<LoadingPage/>}><StaffLogin/></Suspense>}/><Route path="/staff/setup" element={<Suspense fallback={<LoadingPage/>}><StaffSetup/></Suspense>}/><Route path="/staff" element={<Suspense fallback={<LoadingPage/>}><StaffConsole/></Suspense>}/>
    <Route path="/legal/:slug" element={<LegalPage/>}/><Route path="/help" element={<HelpPage/>}/><Route path="/help/:kind" element={<HelpPage/>}/><Route path="/claim-account" element={<Navigate to="/help/claim" replace/>}/><Route path="/protest" element={<Navigate to="/help/protest" replace/>}/><Route path="/account-dispute" element={<Navigate to="/help/dispute" replace/>}/><Route path="/report-fake-site" element={<Navigate to="/help/report" replace/>}/>
    <Route path="*" element={<NotFound/>}/>
  </Routes></PageFrame>;
}
