import type { Route } from '../router.ts';

interface Props {
  route: Route;
  navigate: (to: string) => void;
}

interface NavItem {
  to: string;
  label: string;
  match: (r: Route) => boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Scans', match: r => r.name === 'home' || r.name === 'scan' },
  { to: '/new', label: 'New scan', match: r => r.name === 'new' },
  { to: '/settings', label: 'Settings', match: r => r.name === 'settings' },
];

export function TopBar({ route, navigate }: Props) {
  return (
    <header className="topbar">
      <button
        type="button"
        className="brand"
        onClick={() => navigate('/')}
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit', font: 'inherit' }}
      >
        <span className="brand-mark" />
        <span>Probus</span>
        <span className="brand-sub">/ ai vulnerability scanner</span>
      </button>

      <nav className="nav-links">
        {NAV.map(item => (
          <button
            key={item.to}
            type="button"
            className={`nav-link${item.match(route) ? ' active' : ''}`}
            onClick={() => navigate(item.to)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <span className="spacer" />

      <span className="topbar-meta">
        <span>
          <span className="label">Docs</span>
          <a
            className="value"
            style={{ color: 'var(--text-1)', textDecoration: 'none' }}
            href="https://github.com/etairl/Probus"
            target="_blank"
            rel="noreferrer"
          >github.com/etairl/Probus</a>
        </span>
      </span>
    </header>
  );
}
