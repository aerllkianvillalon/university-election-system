import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Candidate } from '../../lib/api/types';

export function Button({ children, variant = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' | 'danger' }) {
  return <button className={`btn btn-${variant} ${className}`} {...props}>{children}</button>;
}
export function ActionLink({ children, to, variant = 'primary', className = '' }: { children: ReactNode; to: string; variant?: 'primary' | 'secondary' | 'quiet'; className?: string }) {
  return <Link className={`btn btn-${variant} ${className}`} to={to}>{children}</Link>;
}
export function IconBadge({ children, tone = 'teal', className = '' }: { children: ReactNode; tone?: 'teal' | 'indigo' | 'rose'; className?: string }) {
  return <span className={`icon-badge icon-badge-${tone} ${className}`} aria-hidden="true">{children}</span>;
}
export function Card({ children, className = '', ...props }: HTMLAttributes<HTMLElement> & { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`} {...props}>{children}</section>;
}
export function Eyebrow({ children }: { children: ReactNode }) { return <div className="eyebrow">{children}</div>; }
export function SectionHeading({ eyebrow, title, highlight, body }: { eyebrow?: string; title: string; highlight?: string; body?: string }) {
  return <div className="section-heading">
    {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
    <h2>{title}{highlight && <> <span className="highlight-word">{highlight}</span></>}</h2>
    {body && <p>{body}</p>}
  </div>;
}
export function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'alert' }) {
  return <span className={`status-pill status-${tone}`}><span className="status-dot" />{children}</span>;
}
export function CandidateCard({ candidate, selected = false, onClick, selectable = false }: { candidate: Candidate; selected?: boolean; onClick?: () => void; selectable?: boolean }) {
  const inner = <>
    <div className="candidate-photo-wrap">
      <img className="candidate-photo" src={candidate.photo} alt={candidate.photoAlt ?? `Portrait of ${candidate.name}`} loading="lazy" />
      {selected && <span className="candidate-selected" aria-label="Selected">✓</span>}
    </div>
    <div className="candidate-content">
      <span className="candidate-tag">{candidate.tag}</span>
      <h3>{candidate.name}</h3>
      {candidate.program && <p className="candidate-program">{candidate.program}</p>}
      {candidate.statement && <p className="candidate-statement">“{candidate.statement}”</p>}
    </div>
  </>;
  return selectable ? <button type="button" className={`candidate-card selectable ${selected ? 'selected' : ''}`} aria-pressed={selected} onClick={onClick}>{inner}</button> : <article className="candidate-card">{inner}</article>;
}
export function StatCard({ label, value, note, icon }: { label: string; value: string | number; note?: string; icon?: ReactNode }) {
  return <Card className="stat-card"><div className="stat-top"><span>{label}</span>{icon && <IconBadge>{icon}</IconBadge>}</div><strong>{value}</strong>{note && <small>{note}</small>}</Card>;
}
