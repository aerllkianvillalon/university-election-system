import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ArrowUpRight, BadgeCheck, Check, CheckCircle2, CircleHelp, ClipboardCheck, Clock3, Eye, EyeOff, Flag, LockKeyhole, LogOut, Menu, Moon, ShieldCheck, Sun, Users, Vote } from 'lucide-react';
import { api } from '../lib/api/client';
import { rankContest } from '../lib/results';
const StaffLogin=lazy(()=>import('../features/staff/StaffPages').then((m)=>({default:m.StaffLogin})));
const StaffSetup=lazy(()=>import('../features/staff/StaffPages').then((m)=>({default:m.StaffSetup})));
const StaffConsole=lazy(()=>import('../features/staff/StaffPages').then((m)=>({default:m.StaffConsole})));
import { GENERIC_FAILURE_MESSAGE, type BallotDraft, type Candidate, type Choices, type CertifiedResult, type ResultsProof, type Election, type OrganizationElection, type Receipt, type SelectionMap } from '../lib/api/types';
import { ActionLink, Button, CandidateCard, Card, Eyebrow, IconBadge, StatusPill } from '../components/ui/Primitives';
import { HelpPage } from '../features/support/SupportPages';
import { Assistant } from '../features/assistant/Assistant';

function BrandMark() {
  return <span className="brand-mark"><svg width="25" height="25" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 9h16v11H4zM7 9V5h10v4M8 14l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></span>;
}

function Header({ theme, setTheme }: { theme: 'light' | 'dark'; setTheme: (value: 'light' | 'dark') => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const navigate = useNavigate();
  useEffect(() => { let on = true; void api.hasSession().then((yes) => { if (on && yes) setLoggedIn(true); });   // a reload keeps the cookie, so ask the server
    const onLogin = () => setLoggedIn(true); window.addEventListener('ctu-login', onLogin); return () => { on = false; window.removeEventListener('ctu-login', onLogin); }; }, []);
  const links = [['/election', 'Election'], ['/candidates', 'Candidates'], ['/status', 'My status'], ['/results', 'Results']];
  const menu: [string, string[][]][] = [
    ['Voting', [['/election', 'Election details'], ['/candidates', 'Candidates'], ['/status', 'My status'], ['/results', 'Results'], ['/register', 'Create an account'], ['/login', 'Sign in']]],
    ['Need help?', [['/protest', 'File a protest'], ['/account-dispute', 'Account dispute'], ['/claim-account', 'Claim an account'], ['/report-fake-site', 'Report a fake site']]],
    ['About', [['/legal/privacy', 'Privacy'], ['/legal/terms', 'Terms'], ['/legal/election-rules', 'Election rules'], ['/legal/accessibility', 'Accessibility']]],
    ['Staff', [['/staff', 'Staff sign in']]],
  ];
  const close = () => setMenuOpen(false);
  useEffect(() => { if (!menuOpen) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [menuOpen]);
  async function logOut() { await api.logout(); setLoggedIn(false); setMenuOpen(false); navigate('/'); }
  return <header className="topbar"><div className="topbar-inner">
    <Link className="brand" to="/" aria-label="CTU Danao Student Elections home"><BrandMark/><span className="brand-copy"><strong>CTU DANAO</strong><span>STUDENT ELECTIONS</span></span></Link>
    <nav className="nav-links" aria-label="Main navigation">{links.map(([to, label]) => <NavLink key={to} to={to}>{label}</NavLink>)}</nav>
    <div className="nav-actions">
      <button className="icon-button" type="button" aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={18}/> : <Sun size={18}/>}</button>
      {loggedIn ? <><ActionLink to="/vote" className="desktop-only">Vote</ActionLink><button className="btn btn-quiet btn-sm" onClick={logOut}><LogOut size={15}/> Sign out</button></> : <ActionLink to="/login" className="desktop-only">Sign in to vote</ActionLink>}
      <button className="icon-button menu-toggle" aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'} aria-expanded={menuOpen} aria-controls="mobile-navigation" onClick={() => setMenuOpen(!menuOpen)}><Menu size={19}/></button>
    </div>
  </div>
  <nav id="mobile-navigation" className={`nav-mobile menu-panel ${menuOpen ? 'open' : ''}`} aria-label="Site menu">
    <div className="menu-inner">
      <NavLink to={loggedIn?'/vote':'/login'} className="nav-vote" onClick={close}>{loggedIn?'Vote now':'Sign in to vote'}</NavLink>
      <div className="menu-cols">
        {menu.map(([heading, items]) => <div className="menu-group" key={heading}><h2>{heading}</h2>{items.map(([to, label]) => <NavLink key={to} to={to} onClick={close}>{label}</NavLink>)}</div>)}
      </div>
      {loggedIn && <button className="btn btn-quiet menu-out" onClick={logOut}><LogOut size={15}/> Sign out</button>}
    </div>
  </nav></header>;
}

function Footer() {
  return <footer className="footer"><div className="footer-inner"><div><strong>CTU Danao · Student Elections</strong><div>Questions or problems? Contact the Electoral Committee.</div></div><div className="footer-links"><Link to="/legal/privacy">Privacy</Link><Link to="/legal/terms">Terms</Link><Link to="/legal/election-rules">Election rules</Link><Link to="/legal/accessibility">Accessibility</Link><Link to="/protest">File a protest</Link><Link to="/account-dispute">Account dispute</Link><Link to="/claim-account">Claim account</Link><Link to="/report-fake-site">Report a fake site</Link></div></div></footer>;
}

function PageFrame({ children, theme, setTheme }: { children: ReactNode; theme: 'light' | 'dark'; setTheme: (value: 'light' | 'dark') => void }) {
  return <div className={`site-frame ${theme === 'dark' ? 'theme-dark' : ''}`}><a className="skip-link" href="#main-content">Skip to content</a><Header theme={theme} setTheme={setTheme}/><main className="app-main" id="main-content" tabIndex={-1}>{children}</main><Footer/><Assistant/></div>;
}

function Home() {
  const [election, setElection] = useState<Election | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [voted, setVoted] = useState(false);
  useEffect(() => { void api.getCurrentElection().then(setElection);
    const check = () => { void api.getStatus().then((st) => { setSignedIn(st.signedIn !== false); setVoted(st.ballot === 'voted'); }); };
    check(); window.addEventListener('ctu-login', check); return () => window.removeEventListener('ctu-login', check); }, []);
  const st = election?.status;
  let title = 'Cast your vote.', lead = signedIn ? 'You are signed in. Your ballot is ready.' : 'Sign in with your student ID and voucher. It takes about two minutes.';
  let primary: [string, string] = [signedIn ? '/vote' : '/login', signedIn ? 'Go to my ballot' : 'Sign in to vote'];
  let secondary: [string, string] = ['/candidates', 'See the candidates'];
  let showHow = true;
  if (election && st !== 'Open') {
    showHow = st === 'Upcoming' || st === 'Paused';
    if (st === 'Upcoming') { title = 'Voting opens soon.'; lead = election.opensAt ? `Voting opens ${election.opensAt}. Until then you can read about the candidates and the rules.` : 'Voting has not opened yet. Until then you can read about the candidates and the rules.'; primary = ['/election', 'Voting dates and rules']; }
    else if (st === 'Paused') { title = 'Voting is paused.'; lead = 'The Electoral Committee has paused voting for now. Please check back shortly.'; primary = ['/status', 'Check my status']; }
    else { title = 'Voting has closed.'; lead = st === 'Certified' ? 'The results have been certified and published.' : 'Thank you to everyone who voted. Results are published after certification.'; primary = ['/results', 'See results']; secondary = ['/status', 'Check my status']; }
  } else if (election && voted) { title = 'You have voted. Thank you.'; lead = 'Your ballot was recorded. You cannot change it or vote again.'; primary = ['/status', 'View my status']; secondary = ['/results', 'Results']; showHow = false; }
  const open = st === 'Open';
  return <>
    <section className="hero-panel" aria-labelledby="hero-title"><div className="hero-copy">
      <span className="hero-chip"><span className={`status-dot${open ? ' live' : ''}`}/>{open && election?.closesAt ? `Voting is open · closes ${election.closesAt}` : election ? ({ Upcoming: 'Voting has not opened yet', Paused: 'Voting is paused', Closed: 'Voting is closed', Certified: 'Results are published' } as Record<string, string>)[st ?? ''] ?? 'CTU Danao · Student Elections' : 'CTU Danao · Student Elections'}</span>
      <h1 id="hero-title">{title}</h1>
      <p className="hero-lead">{lead}</p>
      <div className="hero-actions"><ActionLink to={primary[0]}>{primary[1]} <ArrowRight size={16}/></ActionLink><ActionLink to={secondary[0]} variant="secondary">{secondary[1]}</ActionLink></div>
      {!signedIn && open && <p className="hero-sub">No account yet? <Link to="/register">Create one with your voucher</Link></p>}
    </div></section>
    {showHow && <section className="home-section"><h2 className="section-title">How voting works</h2>
      <ol className="steps">
        <li className="card step"><span className="step-num">1</span><h3>Sign in</h3><p>Use your student ID and the voucher from the Electoral Committee.</p></li>
        <li className="card step"><span className="step-num">2</span><h3>Choose, then review</h3><p>One contest at a time. Check everything before you submit.</p></li>
        <li className="card step"><span className="step-num">3</span><h3>Keep your receipt</h3><p>It proves your ballot was counted and never shows how you voted.</p></li>
      </ol>
    </section>}
    <p className="home-links"><Link to="/election">Voting dates and rules</Link> · <Link to="/status">Check my status or a receipt</Link> · <Link to="/help/claim">Need help?</Link></p>
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
    <div className="two-col"><Card><Eyebrow>Voting window</Eyebrow><h2 style={{font:'700 24px var(--display)',margin:'0 0 18px'}}>{election.title}</h2><div className="info-list"><div className="info-row"><IconBadge><Clock3 size={17}/></IconBadge><div><strong>Opens</strong><p>{election.opensAt}</p></div></div><div className="info-row"><IconBadge><Flag size={17}/></IconBadge><div><strong>Closes</strong><p>{election.closesAt}</p></div></div><div className="info-row"><IconBadge><Users size={17}/></IconBadge><div><strong>Who can vote</strong><p>Currently enrolled CTU Danao students on the verified voter roll for {organization.name}.</p></div></div></div><ActionLink to={`/candidates?org=${organization.id}`} variant="secondary">Review candidate profiles <ArrowRight size={15}/></ActionLink></Card>
      <div style={{display:'grid',gap:14}}><Card><IconBadge><ShieldCheck size={19}/></IconBadge><h3 style={{font:'700 19px var(--display)'}}>A private ballot</h3><p style={{color:'var(--muted)',fontSize:13}}>Your selections are encrypted before they are stored, and your receipt does not show how you voted.</p></Card><Card><IconBadge><CircleHelp size={19}/></IconBadge><h3 style={{font:'700 19px var(--display)'}}>Need help?</h3><p style={{color:'var(--muted)',fontSize:13}}>Visit the proctor station or contact the campus election committee if you need assistance.</p><ActionLink to="/legal/election-rules" variant="quiet">Read election rules</ActionLink></Card></div></div>
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
  return <><div className="page-head"><div><Eyebrow>{context.organization.name} · candidate guide</Eyebrow><h1>Meet your <span className="highlight-word">candidates.</span></h1><p>Get to know the candidates on your ballot. No vote totals are shown here.</p></div><StatusPill tone={context.election.status === 'Open' ? 'success' : 'warning'}>{context.election.status === 'Open' ? 'Profiles open' : 'Election upcoming'}</StatusPill></div>
    <div className="filter-row"><button className={`btn ${contest==='all'?'btn-primary':'btn-quiet'}`} onClick={() => setContest('all')}>All contests</button>{contests.map((item) => <button key={item.id} className={`btn ${contest===item.id?'btn-primary':'btn-quiet'}`} onClick={() => setContest(item.id)}>{item.title}</button>)}</div>
    {context.election.signedIn===false?<Card className="empty-state"><IconBadge><LockKeyhole size={20}/></IconBadge><h2>Sign in to see your candidates.</h2><p>Your ballot depends on your program and year, so the candidate list is shown after you sign in.</p><ActionLink to="/login">Sign in <ArrowRight size={15}/></ActionLink></Card>:<div className="candidate-grid">{candidates.map((candidate) => <CandidateCard candidate={candidate} key={candidate.id}/>)}</div>}
    <div style={{display:'flex',justifyContent:'center',marginTop:28}}><ActionLink to={`/vote?org=${context.organization.id}`}>Enter the ballot <ArrowRight size={16}/></ActionLink></div>
  </>;
}

function AuthPage({ mode }: { mode: 'register' | 'login' | 'forgot' | 'reset' }) {
  const goTo=useNavigate();
  const [choices,setChoices]=useState<Choices>({});
  useEffect(()=>{if(mode!=='register')return;let on=true;void api.choices().then((c)=>{if(on)setChoices(c);});return()=>{on=false;};},[mode]);
  const [showPassword,setShowPassword]=useState(false); const [message,setMessage]=useState(''); const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
  // Reset link: the token is read once, taken out of the address bar (history, screenshots, Referer), and checked without being used up.
  const [resetToken]=useState(()=>mode==='reset'?new URLSearchParams(window.location.search).get('token')??'':'');
  const [link,setLink]=useState<'checking'|'valid'|'invalid'>(mode==='reset'?'checking':'valid'); const [resetDone,setResetDone]=useState(false);
  useEffect(()=>{if(mode!=='reset')return;if(resetToken)window.history.replaceState(null,'',window.location.pathname);let on=true;
    void (!resetToken?Promise.resolve(false):api.checkResetLink(resetToken)).then((valid)=>{if(on)setLink(valid?'valid':'invalid');});return()=>{on=false;};},[mode,resetToken]);
  const title={register:'Create your voter account',login:'Sign in to your account',forgot:'Reset your password',reset:'Choose a new password'}[mode];
  const description={register:'Use your student ID and election voucher to get started.',login:'Access your voting status and ballot.',forgot:'We’ll share the next step without confirming whether an account exists.',reset:'Create a new password for your account.'}[mode];
  async function handleSubmit(event:FormEvent<HTMLFormElement>){event.preventDefault();setError('');setMessage('');setBusy(true);const form=new FormData(event.currentTarget);const password=String(form.get('password')||'');
    try {
      if(mode==='register'){
        const accepted=form.get('terms')==='on'; const studentId=String(form.get('studentId')||''); const voucher=String(form.get('voucher')||'');
        if(!studentId||!voucher||password.length<8||!accepted) throw new Error(GENERIC_FAILURE_MESSAGE);
        const pick=(k:string)=>String(form.get(k)||'')||undefined;if(Object.values(choices).some((v)=>v&&v.length)&&(['program','year','section'] as const).some((k)=>choices[k]?.length&&!pick(k)))throw new Error('Please choose your course, year and section.');
        const result=await api.register({studentId,voucher,password,termsAccepted:accepted,program:pick('program'),year:pick('year'),section:pick('section')});if(!result.ok)throw new Error(api.genericFailure());window.dispatchEvent(new Event('ctu-login'));setMessage('Your account is ready. Opening your ballot…');goTo('/vote');
      } else if(mode==='login'){
        const identifier=String(form.get('identifier')||'');if(!identifier||password.length<8)throw new Error(GENERIC_FAILURE_MESSAGE);
        const result=await api.authenticate({identifier,password});if(!result.ok)throw new Error(api.genericFailure());window.dispatchEvent(new Event('ctu-login'));setMessage('Signed in. Opening your ballot…');goTo('/vote');
      } else if(mode==='forgot'){
        const identifier=String(form.get('identifier')||'');if(!identifier)throw new Error(GENERIC_FAILURE_MESSAGE);const result=await api.requestPasswordReset(identifier);if(!result.ok)throw new Error(api.genericFailure());setMessage(result.data.message);
      } else {
        if(password.length<8){setError('Use at least 8 characters for your password.');return;}
        if(password!==String(form.get('confirm')||'')){setError('The two passwords do not match.');return;}
        const result=await api.resetPassword(resetToken,password);if(!result.ok){setError(result.message);return;}setResetDone(true);setMessage(result.data.message);
      }
    }catch{setError(GENERIC_FAILURE_MESSAGE);}finally{setBusy(false);}
  }
  return <div className="auth-split"><aside className="auth-aside"><span className="auth-orb"/><p className="auth-kicker">CTU Danao · Student Elections</p><p className="auth-big">Your ballot.<br/>Your voice.<br/><span>Your campus.</span></p>
      <ul className="auth-points"><li><ShieldCheck size={18}/><span><strong>Private by design</strong>Nobody can see how you voted.</span></li><li><LockKeyhole size={18}/><span><strong>Encrypted ballots</strong>Sealed on your device before they are stored.</span></li><li><BadgeCheck size={18}/><span><strong>One verified vote</strong>Your receipt proves it was counted.</span></li></ul></aside>
    <Card className="form-card"><Eyebrow>Secure student access</Eyebrow><h1 className="form-title">{title}</h1><p className="form-intro">{description}</p>
    {mode==='reset'&&link==='checking'&&<p role="status">Checking your link…</p>}
    {mode==='reset'&&link==='invalid'&&<div className="form-message" role="alert">This link is no longer valid. It may have expired or already been used. <Link to="/forgot-password">Request a new link</Link>.</div>}
    {!(mode==='reset'&&link!=='valid')&&<form noValidate onSubmit={handleSubmit}>
      {mode==='register'&&<><div className="field"><label htmlFor="student-id">Student ID</label><input id="student-id" name="studentId" required autoComplete="username" placeholder="e.g. 2026-00001"/></div><div className="field"><label htmlFor="voucher">Election voucher</label><input id="voucher" name="voucher" required autoComplete="off" placeholder="Enter your voucher"/></div>{([['program','Course'],['year','Year level'],['section','Section']] as const).map(([k,label])=>choices[k]?.length?<div className="field" key={k}><label htmlFor={`pick-${k}`}>{label}</label><select id={`pick-${k}`} name={k} required defaultValue=""><option value="" disabled>Choose your {label.toLowerCase()}</option>{choices[k]!.map((v)=>{return <option key={v} value={v}>{v}</option>;})}</select></div>:null)}</>}
      {mode!=='reset'&&mode!=='register'&&<div className="field"><label htmlFor="identifier">Student ID</label><input id="identifier" name="identifier" required autoComplete="username" placeholder="Enter your student ID"/></div>}
      {mode!=='forgot'&&<div className="field"><label htmlFor="password">{mode==='reset'?'New password':'Password'}</label><div style={{position:'relative'}}><input id="password" name="password" type={showPassword?'text':'password'} required minLength={8} autoComplete={mode==='register'||mode==='reset'?'new-password':'current-password'} placeholder="At least 8 characters" style={{paddingRight:58}}/><button type="button" aria-label={showPassword?'Hide password':'Show password'} className="icon-button" style={{position:'absolute',right:4,top:1,width:48,height:48,border:0,background:'transparent'}} onClick={()=>setShowPassword(!showPassword)}>{showPassword?<EyeOff size={17}/>:<Eye size={17}/>}</button></div><small>Use at least 8 characters. Never share your password.</small></div>}
      {mode==='reset'&&<div className="field"><label htmlFor="confirm">Confirm new password</label><input id="confirm" name="confirm" type={showPassword?'text':'password'} required minLength={8} autoComplete="new-password"/></div>}
      {mode==='register'&&<label className="checkline"><input type="checkbox" name="terms" required/><span>I agree to the <Link to="/legal/terms">Terms of Use</Link> and acknowledge the privacy notice.</span></label>}
      {error&&<div className="form-message" role="alert">{error}</div>}{message&&<div className="form-message" role="status">{message}</div>}
      <Button className="btn-block" type="submit" disabled={busy||resetDone}>{busy?'Please wait…':mode==='register'?'Create account':mode==='login'?'Sign in':mode==='forgot'?'Send instructions':'Update password'} <ArrowRight size={16}/></Button>
    </form>}
    {(mode==='login'||mode==='register')&&<details className="auth-help"><summary>Having trouble?</summary><dl>
      <dt>I forgot my password</dt><dd><Link to="/forgot-password">Reset it here</Link>.</dd>
      <dt>My voucher is not accepted</dt><dd>Check for typing mistakes: the voucher works once. If it still fails, ask the Electoral Committee for help in person.</dd>
      <dt>I am not on the voter roll</dt><dd>Only enrolled students on the roll can vote. Bring your school ID to the Electoral Committee so they can check.</dd>
      <dt>Someone else may have used my account</dt><dd><Link to="/help/claim">Claim your account</Link> or <Link to="/help/dispute">file a dispute</Link>.</dd></dl></details>}
    <div className="form-links">{mode==='login'?<><Link to="/forgot-password">Forgot password?</Link><Link to="/register">Create voter account</Link></>:mode==='register'?<Link to="/login">Already registered? Sign in</Link>:mode==='forgot'?<Link to="/login">Back to sign in</Link>:<Link to="/login">Return to sign in</Link>}</div>
  </Card></div>;
}

function ReceiptCheck(){
  const saved=api.sealReceipt();   // this tab's receipt, kept only until you sign out or close the tab
  const [code,setCode]=useState('');const [res,setRes]=useState<'' | 'sealed' | 'recorded' | 'unknown' | 'invalid' | 'busy' | 'error' | 'wait'>('');
  useEffect(()=>{if(window.location.hash==='#check-receipt')document.getElementById('check-receipt')?.scrollIntoView({block:'center'});},[]);
  async function run(e:FormEvent){e.preventDefault();setRes('wait');setRes(await api.checkReceipt(code));}
  const msg:Record<string,[string,string]>={sealed:['success','Found. Your ballot is recorded and confirmed.'],recorded:['success','Found. Your ballot is recorded. Final confirmation is still in progress, so check again later.'],unknown:['warning','No ballot matches this code. Check for typing mistakes. If you are sure it is right, tell the Electoral Committee.'],invalid:['warning','That does not look like a receipt code. It is 64 letters and numbers (0-9, a-f).'],busy:['warning','Too many checks. Please wait a minute and try again.'],error:['warning','Could not reach the server. Check your connection and try again.']};
  return <Card className="receipt-check"><div id="check-receipt"/><Eyebrow>Receipt check</Eyebrow><h2 style={{font:'700 22px var(--display)',margin:'4px 0 6px'}}>Check a receipt code</h2><p style={{color:'var(--muted)',fontSize:13,margin:'0 0 14px'}}>Paste the code you saved when you voted. It only tells you whether the ballot was recorded, never how anyone voted.</p>
    <form onSubmit={run} noValidate><div className="field"><label htmlFor="receipt-code">Receipt code</label><input id="receipt-code" value={code} onChange={(e)=>setCode(e.target.value)} autoComplete="off" spellCheck={false} placeholder="64-character code" style={{fontFamily:'ui-monospace,monospace'}}/></div><Button type="submit" disabled={!code.trim()||res==='wait'}>{res==='wait'?'Checking…':'Check code'}</Button>{saved&&<Button type="button" variant="secondary" disabled={res==='wait'} onClick={()=>{setCode(saved.hash);setRes('wait');void api.checkReceipt(saved.hash).then(setRes);}}>Check my saved receipt</Button>}</form>
    {msg[res]&&<div className={`alert-box alert-${msg[res][0]}`} role="status" style={{marginTop:14}}>{msg[res][1]}</div>}</Card>;
}

function StatusPage() {
  const [params]=useSearchParams();const organizationId=params.get('org')??undefined;
  const [status,setStatus]=useState<{eligible:boolean;ballot:'not-started'|'voted';message:string;signedIn?:boolean}|null>(null);const [context,setContext]=useState<OrganizationElection|null>(null);
  useEffect(()=>{void api.getStatus().then(setStatus);void api.getOrganizationElection(organizationId).then(setContext);},[organizationId]);
  return <><div className="page-head"><div><Eyebrow>Voter status</Eyebrow><h1>Your status, <span className="highlight-word">at a glance.</span></h1><p>Check whether your ballot has been recorded.</p></div></div>
    {!status||!context?<LoadingPage/>:<div className="two-col"><Card><StatusPill tone={status.signedIn===false?'warning':'success'}>{status.signedIn===false?'Sign in required':status.eligible?'Eligible to vote':'Not eligible'}</StatusPill><h2 style={{font:'700 26px var(--display)',margin:'20px 0 4px'}}>{context.election.title}</h2><p style={{color:'var(--muted)',fontSize:13}}>{status.message}</p><div className="info-list"><div className="info-row"><IconBadge><CheckCircle2 size={18}/></IconBadge><div><strong>Voter roll</strong><p>{status.signedIn===false?'Sign in to check your record.':'You are on the voter roll for this election.'}</p></div></div><div className="info-row"><IconBadge><Vote size={18}/></IconBadge><div><strong>Ballot</strong><p>{status.ballot==='voted'?'Submitted · verification in progress':'Not yet submitted'}</p></div></div></div>{status.signedIn===false?<ActionLink to="/login">Sign in <ArrowRight size={16}/></ActionLink>:status.ballot==='not-started'?<ActionLink to={`/vote?org=${context.organization.id}`}>Enter ballot <ArrowRight size={16}/></ActionLink>:<ActionLink to="/receipt" variant="quiet">View receipt</ActionLink>}</Card><Card><IconBadge><LockKeyhole size={19}/></IconBadge><h3 style={{font:'700 19px var(--display)'}}>Your choice stays private</h3><p style={{fontSize:13,color:'var(--muted)'}}>Only an aggregate participation status appears here. Candidate-level results remain hidden until an election is certified.</p></Card></div>}
    <ReceiptCheck/>
  </>;
}

// Certified counts for one contest. Winners are deliberately NOT declared: the winner and tie rules are an election-committee decision.
function ContestCounts({result}:{result:CertifiedResult}){
  const seats=result.seats??1, {rows,tie,short}=rankContest(result.candidates??[],seats);
  return <Card><Eyebrow>Certified count</Eyebrow><h2 style={{font:'700 22px var(--display)',margin:'0 0 12px'}}>{result.title}</h2>
    <table className="results-table"><caption className="sr-only">Votes for {result.title}. {seats===1?'One seat.':`${seats} seats.`}</caption>
      <thead><tr><th scope="col">Candidate</th><th scope="col" className="num">Votes</th><th scope="col">Standing</th></tr></thead>
      <tbody>{rows.map((c)=><tr key={c.id}><th scope="row">{c.name}</th><td className="num">{c.votes.toLocaleString()}</td><td>{c.standing}</td></tr>)}
        <tr><th scope="row">Abstained</th><td className="num">{(result.abstain??0).toLocaleString()}</td><td></td></tr></tbody></table>
    {short&&<div className="alert-box" role="note" style={{marginTop:12,fontSize:12}}>{seats===1?'No candidate received votes.':'Fewer candidates received votes than there are seats.'} The election rules decide what happens next.</div>}
    {tie&&<div className="alert-box" role="note" style={{marginTop:12,fontSize:12}}>Tied for the last seat. The election rules decide how this is resolved; no winner is declared here.</div>}
    <p style={{color:'var(--muted)',fontSize:11}}>Certified {result.certifiedAt}</p></Card>;
}
function ResultsPage() {
  const [results,setResults]=useState<CertifiedResult[]|null>(null);const [locked,setLocked]=useState(true);const [proof,setProof]=useState<ResultsProof|null>(null);
  async function load(){setResults(null);const response=await api.getResults();if(response.ok){setLocked(false);setResults(response.data);setProof(api.getResultsProof());}else{setLocked(true);setResults([]);setProof(null);}}
  useEffect(()=>{void load();},[]);
  return <><div className="page-head"><div><Eyebrow>Election results</Eyebrow><h1>Results with <span className="highlight-word">integrity.</span></h1><p>Results are published only after a formal certification decision.</p></div><StatusPill tone={locked?'warning':'success'}>{locked?'Awaiting certification':'Certified'}</StatusPill></div>
    {locked?<Card className="empty-state"><IconBadge><LockKeyhole size={20}/></IconBadge><h2>Results are not available yet.</h2><p>Candidate-level results are withheld until independent certification is complete.</p><StatusPill tone="warning">Not certified</StatusPill></Card>:<><div className="admin-grid">{results?.map((result)=><ContestCounts key={result.contestId} result={result}/>)}</div>{proof&&<Card style={{marginTop:18}}><h2 style={{font:'700 18px var(--display)',margin:'0 0 8px'}}>{proof.ballots.toLocaleString()} ballots counted</h2><p style={{color:'var(--muted)',fontSize:13}}>These counts were signed after the tally and checked against the sealed ballots before they were certified. You can check them yourself.</p>
      <details><summary>How to check these counts</summary><p style={{fontSize:13}}>Save each signed tally below, together with the signing key, and run <code>ev verify-results</code>. The signing key fingerprint is <strong>{proof.signingKeyFingerprint}</strong>; it should match the one announced at the key ceremony.</p>
        <p style={{fontSize:12,margin:'8px 0 4px'}}>Signing key</p><pre className="proof" tabIndex={0} aria-label="Signing key">{proof.signingKey}</pre>
        {proof.sets.map((set)=><div key={set.chain}><p style={{fontSize:12,margin:'8px 0 4px'}}>Signed tally, chain {set.chain}</p><pre className="proof" tabIndex={0} aria-label={`Signed tally for chain ${set.chain}`}>{JSON.stringify({body:set.body,signature:set.signature},null,2)}</pre></div>)}</details></Card>}</>}
  </>;
}

function Ballot() {
  const navigate=useNavigate();const [params]=useSearchParams();const organizationId=params.get('org')??undefined;const [context,setContext]=useState<OrganizationElection|null>(null);const election=context?.election??null;const [draft,setDraft]=useState<BallotDraft>(()=>api.getDraft());const [step,setStep]=useState(0);const [review,setReview]=useState(false);const [error,setError]=useState('');const [secondsLeft,setSecondsLeft]=useState(()=>Math.max(0,Math.floor((api.getDraft().expiresAt-Date.now())/1000)));const [voted,setVoted]=useState(false);const [statusKnown,setStatusKnown]=useState(false);
  useEffect(()=>{void api.getStatus().then((st)=>{setVoted(st.ballot==='voted');setStatusKnown(true);});},[]);
  useEffect(()=>{void api.getOrganizationElection(organizationId).then((next)=>{setContext(next);const current=api.getDraft(next.election.id);setDraft(current);setSecondsLeft(Math.max(0,Math.floor((current.expiresAt-Date.now())/1000)));const firstOpen=next.election.contests.findIndex((c)=>!(current.selections[c.id]?.length));setStep(firstOpen<0?Math.max(0,next.election.contests.length-1):firstOpen);setReview(false);setError('');});},[organizationId]);
  useEffect(()=>{const timer=window.setInterval(()=>{const left=Math.max(0,Math.floor((draft.expiresAt-Date.now())/1000));setSecondsLeft(left);if(left===0){api.clearBallot('expiry',election?.id);setDraft({electionId:election?.id??'election-current',selections:{},expiresAt:Date.now()});setError('Your ballot session expired. Your selections were cleared. Start again when you’re ready.');window.clearInterval(timer);}},1000);return()=>window.clearInterval(timer);},[draft.expiresAt,election?.id]);
  if(!election)return <LoadingPage/>;
  if(election.signedIn===false)return <Card className="empty-state"><IconBadge><LockKeyhole size={20}/></IconBadge><h2>Sign in to vote.</h2><p>Your ballot is prepared for you after you sign in.</p><ActionLink to="/login">Sign in <ArrowRight size={15}/></ActionLink></Card>;
  if(!statusKnown)return <LoadingPage/>;
  if(voted)return <Card className="empty-state"><IconBadge><CheckCircle2 size={20}/></IconBadge><h1>You have already voted.</h1><p>Your ballot was recorded. You cannot change it or vote again.</p><div className="empty-actions">{api.getReceipt()&&<ActionLink to="/receipt">View my receipt</ActionLink>}<ActionLink to="/status" variant={api.getReceipt()?'secondary':'primary'}>Check my status</ActionLink></div></Card>;
  if(election.status!=='Open')return <Card className="empty-state"><IconBadge><Clock3 size={20}/></IconBadge><h1>{election.status==='Upcoming'?'Voting has not opened yet.':election.status==='Paused'?'Voting is paused.':'Voting has closed.'}</h1><p>{election.status==='Upcoming'?(election.opensAt?`Voting opens ${election.opensAt}. Come back then to cast your ballot.`:'Come back when voting opens to cast your ballot.'):election.status==='Paused'?'The Electoral Committee has paused voting. Please check back shortly. Nothing you chose has been lost.':'This election is no longer accepting ballots.'}</p><div className="empty-actions"><ActionLink to={election.status==='Closed'||election.status==='Certified'?'/results':'/election'}>{election.status==='Closed'||election.status==='Certified'?'See results':'Voting dates and rules'}</ActionLink></div></Card>;
  if(election.contests.length===0)return <Card className="empty-state"><IconBadge><CircleHelp size={20}/></IconBadge><h2>There is nothing to vote on for you.</h2><p>No contests are open to you in this election. If you think this is a mistake, contact the Electoral Committee.</p><ActionLink to="/status" variant="secondary">Check my status</ActionLink></Card>;
  const activeElection=election;const contests=activeElection.contests;const contest=contests[step];const chosen=draft.selections[contest?.id]||[];
  function store(next:SelectionMap){api.saveSelections(next,activeElection.id);setDraft(api.getDraft(activeElection.id));setError('');}
  function toggle(candidate:Candidate){const previous=draft.selections[contest.id]||[];const old=previous.includes('abstain')?[]:previous;let updated:string[];if(old.includes(candidate.id))updated=old.filter((id)=>id!==candidate.id);else if(contest.seats===1)updated=[candidate.id];else if(old.length>=contest.seats){setError(`Choose no more than ${contest.seats} candidates for this contest.`);return;}else updated=[...old,candidate.id];store({...draft.selections,[contest.id]:updated});}
  function abstain(checked:boolean){store({...draft.selections,[contest.id]:checked?['abstain']:[]});}
  async function submit(){try{const receipt=await api.submitBallot(activeElection.id);navigate('/receipt',{state:{receipt,organizationId:activeElection.organizationId}});}catch(cause){setError(cause instanceof Error?cause.message:GENERIC_FAILURE_MESSAGE);}}
  if(secondsLeft===0&&error.startsWith('Your ballot session expired')) return <Card className="empty-state"><IconBadge><Clock3 size={20}/></IconBadge><h2>Ballot session expired.</h2><p>Your selections have been cleared. Nothing was submitted.</p><Button onClick={()=>{api.saveSelections({},activeElection.id);setDraft(api.getDraft(activeElection.id));setSecondsLeft(600);setStep(0);setReview(false);setError('');}}>Restart ballot</Button></Card>;
  if(review)return <section className="vote-layout"><Eyebrow>Review before you submit</Eyebrow><h1 style={{font:'700 clamp(34px,6vw,54px)/1 var(--display)',letterSpacing:'-.06em'}}>Your choices.<br/><span className="highlight-word">Your final check.</span></h1><p style={{color:'var(--muted)'}}>Take a moment to review each contest. Submission cannot be undone.</p><div className="review-list">{contests.map((item,index)=>{const ids=draft.selections[item.id]||[];const names=ids.includes('abstain')?['Abstain']:item.candidates.filter((person)=>ids.includes(person.id)).map((person)=>person.name);return <Card className="review-item" key={item.id}><div><Eyebrow>Contest {index+1}</Eyebrow><strong>{item.title}</strong><p>{names.join(', ')||'No selection'}</p></div><Button variant="quiet" onClick={()=>{setStep(index);setReview(false);}}>Edit</Button></Card>;})}</div><div className="alert-box alert-warning review-warning" role="note"><strong>Important:</strong> Submitting your ballot is final. You cannot change it or vote again.</div>{error&&<div className="form-message" role="alert">{error}</div>}<div className="vote-sticky"><Button variant="quiet" onClick={()=>setReview(false)}><ArrowLeft size={16}/> Back to ballot</Button><Button onClick={()=>void submit()}>Submit my ballot <Check size={17}/></Button></div></section>;
  return <section className="vote-layout"><div className="vote-top"><div><Eyebrow>Private ballot</Eyebrow><strong style={{fontSize:13}}>Contest {step+1} of {contests.length}</strong></div><StatusPill tone={secondsLeft<60?'warning':'neutral'}><Clock3 size={13}/> {Math.floor(secondsLeft/60)}:{String(secondsLeft%60).padStart(2,'0')}</StatusPill></div><div className="progress-track" role="progressbar" aria-label="Ballot progress" aria-valuemin={0} aria-valuemax={contests.length} aria-valuenow={step+1}><div className="progress-fill" style={{width:`${((step+1)/contests.length)*100}%`}}/></div>
    <div className="vote-contest" key={contest.id}><div style={{marginTop:22}}><Eyebrow>{activeElection.title}</Eyebrow><h1>{contest.title}</h1><p className="vote-sub">{contest.description}</p>{contest.seats>1&&<StatusPill tone="warning">Select up to {contest.seats} · {chosen.filter((id)=>id!=='abstain').length} selected</StatusPill>}</div>
      <div className="vote-grid">{contest.candidates.map((candidate)=><CandidateCard key={candidate.id} candidate={candidate} selectable selected={chosen.includes(candidate.id)} onClick={()=>toggle(candidate)}/>)}</div>
      <p className="guide-link"><a href="/candidates" target="_blank" rel="noopener">Read the full candidate guide <ArrowUpRight size={13}/></a> (opens in a new tab)</p>
      {contest.allowAbstain!==false&&<label className="abstain-card"><input type="checkbox" checked={chosen.includes('abstain')} onChange={(event)=>abstain(event.target.checked)}/><span><strong>Abstain from this contest</strong><br/><small style={{color:'var(--muted)',fontWeight:400}}>Leave this position blank and continue.</small></span></label>}
    </div>
    {secondsLeft>0&&secondsLeft<=120&&<div className="alert-box alert-warning time-warning" role="alert"><span>Your ballot session ends in {Math.max(1,Math.ceil(secondsLeft/60))} min. Your choices will be cleared.</span><Button variant="secondary" onClick={()=>{api.saveSelections(draft.selections,activeElection.id);const fresh=api.getDraft(activeElection.id);setDraft(fresh);setSecondsLeft(Math.floor((fresh.expiresAt-Date.now())/1000));}}>I need more time</Button></div>}
    {error&&<div className="form-message" role="alert">{error}</div>}
    <div className="vote-sticky"><Button variant="quiet" onClick={()=>{setError('');if(step===0)navigate(`/election?org=${activeElection.organizationId}`);else setStep(step-1);}}><ArrowLeft size={16}/> Back</Button><span className="vote-count">Choices are saved on this device until you submit.</span>{step<contests.length-1?<Button onClick={()=>{if(!chosen.length){setError('Choose a candidate or abstain before continuing.');return;}setError('');setStep(step+1);}} disabled={!chosen.length}>Next contest <ArrowRight size={16}/></Button>:<Button onClick={()=>{if(!chosen.length){setError('Choose a candidate or abstain before continuing.');return;}setError('');setReview(true);}}>Review ballot <ClipboardCheck size={16}/></Button>}</div>
  </section>;
}

function copyText(text:string):Promise<boolean>{
  if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(text).then(()=>true,()=>false);
  try{const t=document.createElement('textarea');t.value=text;t.setAttribute('readonly','');t.style.position='fixed';t.style.opacity='0';document.body.appendChild(t);t.select();const ok=document.execCommand('copy');document.body.removeChild(t);return Promise.resolve(ok);}catch{return Promise.resolve(false);}
}
function ReceiptPage() {
  const [copied,setCopied]=useState<'' | 'yes' | 'no'>('');
  const navigate=useNavigate();const [receipt,setReceipt]=useState<Receipt|null>(()=>api.getReceipt());
  useEffect(()=>{if(!receipt||receipt.state==='sealed')return;let tries=0;const timer=window.setInterval(()=>{tries+=1;const next=api.sealReceipt();if(next&&next.state!==receipt.state)setReceipt(next);if(tries>=60)window.clearInterval(timer);},5000);return()=>window.clearInterval(timer);},[receipt?.state]);   // live: the sealer runs on its own schedule, so poll until it has
  if(!receipt)return <Card className="empty-state"><IconBadge><Vote size={20}/></IconBadge><h1>No receipt in this tab.</h1><p>Your receipt appears here right after you submit. If you already voted and saved your code, you can check it on the status page.</p><div className="empty-actions"><ActionLink to="/status#check-receipt">Check a receipt code</ActionLink><Button variant="secondary" onClick={()=>navigate('/vote')}>Go to ballot</Button></div></Card>;
  return <Card className="receipt"><div className="receipt-seal"><Check size={38} strokeWidth={3}/></div><StatusPill tone="success">{receipt.state==='recorded'?'Recorded':'Sealed'}</StatusPill><h1 style={{marginTop:17}}>Your ballot is <span className="highlight-word">{receipt.state}.</span></h1><p style={{color:'var(--muted)'}}>We are checking your vote. Your ballot selections are not included in this receipt.</p><div className={`receipt-status ${receipt.state}`}>{receipt.state==='recorded'?'Recorded · verification pending':'Sealed · confirmation complete'}</div><div className="receipt-hash"><span style={{display:'block',color:'var(--muted)',fontFamily:'Inter',marginBottom:5}}>RECEIPT CODE</span>{receipt.hash}</div><p style={{fontSize:11,color:'var(--muted)'}}>Reference {receipt.id} · {receipt.recordedAt}<br/>Keep this code. It lets you check that your ballot was recorded, and it does not reveal your choices.</p><div className="receipt-tools"><Button onClick={()=>{void copyText(receipt.hash).then((ok)=>setCopied(ok?'yes':'no'));}}>{copied==='yes'?'Copied ✓':'Copy code'}</Button><Button variant="secondary" onClick={()=>{const blob=new Blob([`CTU Danao student election receipt\nReceipt code: ${receipt.hash}\nReference: ${receipt.id}\nRecorded: ${receipt.recordedAt}\n\nThis code does not reveal your choices. Use it on the My status page to check that your ballot was recorded.\n`],{type:'text/plain'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='election-receipt.txt';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);}}>Download</Button><Button variant="secondary" onClick={()=>window.print()}>Print</Button></div>{copied==='no'&&<p className="receipt-note" role="status">Could not copy. Select the code above and copy it by hand.</p>}<p className="receipt-note"><strong>Save this code now.</strong> It is only kept in this browser tab, so it is gone once you close the tab. You can check it any time on the <Link to="/status#check-receipt">My status</Link> page.</p><div className="receipt-tools"><ActionLink to="/status" variant="quiet">Check status</ActionLink><ActionLink to="/" variant="quiet">Return home</ActionLink></div></Card>;
}

const legalContent:Record<string,{title:string;intro:string;sections:[string,string][]}>={
  privacy:{title:'Privacy notice',intro:'How this site handles your information while you vote.',sections:[['Identity','Your student ID and voucher are used only to check that you are on the voter roll for this election.'],['Ballot storage','Draft selections stay in your browser session and are cleared on submit, expiry and sign-out. Submitted ballots are stored encrypted and are not linked to your receipt.'],['Help assistant','If the help assistant is switched on, the question you type is sent to an AI service so it can write an answer. The assistant never sees your ballot or who you are, and this site does not store your questions. Do not type your password, voucher or receipt code. The AI service handles the text under its own terms.'],['Questions','Contact the Electoral Committee about how your data is handled.']]},
  terms:{title:'Terms of use',intro:'The terms for using this voting site.',sections:[['Use of this site','Use only your own student ID, voucher and password. Never share them with anyone.'],['Conduct','Use the site respectfully and contact the Electoral Committee for assistance.'],['Official results','Only results that the Electoral Committee has certified and published on this site are official.']]},
  'election-rules':{title:'Election rules',intro:'The rules that apply to this election.',sections:[['Eligibility','Only currently enrolled students on the voter roll for this election can vote.'],['Ballot choices','Seat limits and abstentions are checked by the server, and individual selections are never disclosed.'],['Certification','Results become public only after the certification process is complete.']]},
  accessibility:{title:'Accessibility statement',intro:'This site is designed around keyboard access, clear focus, high contrast, reduced motion, and touch-friendly targets.',sections:[['Support','If you need help voting, contact the Electoral Committee.'],['Feedback','Contact the Electoral Committee with an accessibility concern.']]},
};
function LegalPage(){const {slug=''}=useParams();const content=legalContent[slug];if(!content) return <NotFound/>;return <article className="legal"><nav className="control-row" aria-label="Policies">{Object.entries(legalContent).map(([k,v])=><NavLink key={k} to={`/legal/${k}`}>{v.title}</NavLink>)}</nav><div className="page-head"><div><Eyebrow>CTU Danao · policy</Eyebrow><h1>{content.title}<span className="highlight-word">.</span></h1><p>{content.intro}</p></div></div><Card>{content.sections.map(([title,body])=><section key={title}><h2>{title}</h2><p>{body}</p></section>)}</Card></article>;}
function LoadingPage(){return <section className="card empty-state" aria-live="polite"><div className="skeleton" style={{width:150,margin:'auto'}}/><div className="skeleton" style={{width:'66%',margin:'12px auto'}}/><p>Loading…</p></section>;}
function NotFound(){return <Card className="empty-state"><IconBadge><CircleHelp size={20}/></IconBadge><h2>We can’t find that page.</h2><p>Try returning to the election overview.</p><ActionLink to="/">Back to home <ArrowRight size={15}/></ActionLink></Card>;}

export function App(){
  const [theme,setTheme]=useState<'light'|'dark'>('light');
  useEffect(()=>{document.documentElement.dataset.theme=theme==='dark'?'dark':'light';document.documentElement.style.colorScheme=theme;},[theme]);
  return <PageFrame theme={theme} setTheme={setTheme}><Routes>
    <Route path="/" element={<Home/>}/><Route path="/election" element={<ElectionInfo/>}/><Route path="/candidates" element={<Candidates/>}/>
    <Route path="/register" element={<AuthPage mode="register"/>}/><Route path="/login" element={<AuthPage mode="login"/>}/><Route path="/forgot-password" element={<AuthPage mode="forgot"/>}/><Route path="/reset-password" element={<AuthPage mode="reset"/>}/>
    <Route path="/status" element={<StatusPage/>}/><Route path="/results" element={<ResultsPage/>}/><Route path="/vote" element={<Ballot/>}/><Route path="/receipt" element={<ReceiptPage/>}/>
    <Route path="/admin" element={<Navigate to="/staff" replace/>}/><Route path="/staff/login" element={<Suspense fallback={<LoadingPage/>}><StaffLogin/></Suspense>}/><Route path="/staff/setup" element={<Suspense fallback={<LoadingPage/>}><StaffSetup/></Suspense>}/><Route path="/staff" element={<Suspense fallback={<LoadingPage/>}><StaffConsole/></Suspense>}/>
    <Route path="/legal/:slug" element={<LegalPage/>}/><Route path="/help" element={<HelpPage/>}/><Route path="/help/:kind" element={<HelpPage/>}/><Route path="/claim-account" element={<Navigate to="/help/claim" replace/>}/><Route path="/protest" element={<Navigate to="/help/protest" replace/>}/><Route path="/account-dispute" element={<Navigate to="/help/dispute" replace/>}/><Route path="/report-fake-site" element={<Navigate to="/help/report" replace/>}/>
    <Route path="*" element={<NotFound/>}/>
  </Routes></PageFrame>;
}
