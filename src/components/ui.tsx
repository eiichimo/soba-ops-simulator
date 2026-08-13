import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

export type IconName = 'dashboard' | 'store' | 'capacity' | 'menu' | 'box' | 'recipe' | 'labor' | 'utility' | 'compare' | 'data' | 'trend' | 'info' | 'chevron'

export const Icon = ({ name, size = 20 }: { name: IconName; size?: number }) => {
  const paths: Record<IconName, ReactNode> = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    store: <><path d="M4 10v10h16V10"/><path d="M3 10l2-6h14l2 6"/><path d="M8 20v-6h8v6"/><path d="M3 10c1.2 2 3.8 2 5 0 1.2 2 3.8 2 5 0 1.2 2 3.8 2 5 0 1.2 2 2.2 1 3 0"/></>,
    capacity: <><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/><path d="M3 6l6-3 6 5 6-5"/></>,
    menu: <><path d="M7 3v18M17 3v18M7 7h10M7 12h10M7 17h10"/><circle cx="4" cy="7" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="17" r="1"/></>,
    box: <><path d="M4 7l8-4 8 4-8 4z"/><path d="M4 7v10l8 4 8-4V7M12 11v10"/></>,
    recipe: <><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M9 6h4a5 5 0 015 5v4M15 18H9a3 3 0 01-3-3V9"/></>,
    labor: <><circle cx="9" cy="7" r="4"/><path d="M3 21v-3a6 6 0 0112 0v3M17 8h4M19 6v4"/></>,
    utility: <><path d="M13 2L5 14h7l-1 8 8-12h-7z"/></>,
    compare: <><path d="M4 7h14M15 4l3 3-3 3M20 17H6M9 14l-3 3 3 3"/></>,
    data: <><path d="M12 3v12M8 11l4 4 4-4"/><path d="M4 17v4h16v-4"/></>,
    trend: <><path d="M3 18l6-6 4 4 8-10"/><path d="M16 6h5v5"/></>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
    chevron: <path d="M9 18l6-6-6-6"/>,
  }
  return <svg aria-hidden="true" className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}

export const PageTitle = ({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) => (
  <div className="page-title">
    <div>
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
    {actions && <div className="page-actions">{actions}</div>}
  </div>
)

export const Panel = ({ children, className = '', title, caption, actions }: { children: ReactNode; className?: string; title?: string; caption?: string; actions?: ReactNode }) => (
  <section className={`panel ${className}`}>
    {(title || actions) && <header className="panel-header"><div>{title && <h2>{title}</h2>}{caption && <p>{caption}</p>}</div>{actions}</header>}
    {children}
  </section>
)

export const NumberField = ({ label, suffix, hint, className = '', ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; suffix?: string; hint?: string; className?: string }) => (
  <label className={`field ${className}`}>
    <span className="field-label">{label}</span>
    <span className="input-shell"><input type="number" step="any" {...props} />{suffix && <span>{suffix}</span>}</span>
    {hint && <small>{hint}</small>}
  </label>
)

export const TextField = ({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    <span className="input-shell"><input type="text" {...props} /></span>
    {hint && <small>{hint}</small>}
  </label>
)

export const SelectField = ({ label, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    <span className="input-shell select-shell"><select {...props}>{children}</select></span>
  </label>
)

export const Button = ({ children, variant = 'secondary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) => (
  <button className={`button button-${variant}`} {...props}>{children}</button>
)

export const Badge = ({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'positive' | 'warning' | 'reference' }) => (
  <span className={`badge badge-${tone}`}>{children}</span>
)

export const Toggle = ({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) => (
  <label className="toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span className="toggle-track"><span /></span><span>{label}</span></label>
)

export const EmptyState = ({ children }: { children: ReactNode }) => <div className="empty-state">{children}</div>
