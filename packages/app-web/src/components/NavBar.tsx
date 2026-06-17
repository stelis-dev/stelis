import { useState } from 'react';
import { Link } from 'react-router-dom';
import pkg from '../../package.json';

const APP_VERSION = pkg.version;

interface NavBarProps {
  links: { href: string; label: string }[];
  badge?: React.ReactNode;
}

export function NavBar({ links, badge }: NavBarProps) {
  const [open, setOpen] = useState(false);

  return (
    <nav className="nav">
      <Link to="/" className="nav-brand">
        Stelis
        <span className="nav-version">v{APP_VERSION}</span>
        {badge}
      </Link>

      {/* Desktop links */}
      <div className="nav-links nav-links-desktop">
        {links.map((l) => (
          <Link key={l.href} to={l.href} className="nav-link">
            {l.label}
          </Link>
        ))}
      </div>

      {/* Hamburger button */}
      <button className="nav-hamburger" onClick={() => setOpen(!open)} aria-label="Toggle menu">
        <span className={`hamburger-icon ${open ? 'open' : ''}`} />
      </button>

      {/* Mobile dropdown */}
      {open && (
        <div className="nav-mobile-menu">
          {links.map((l) => (
            <Link
              key={l.href}
              to={l.href}
              className="nav-mobile-link"
              onClick={() => setOpen(false)}
            >
              {l.label}
            </Link>
          ))}
        </div>
      )}
    </nav>
  );
}
