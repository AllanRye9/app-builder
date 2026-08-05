import { useState } from 'react';
import BrandMark from './BrandMark.jsx';
import ThemeSwitcher from './ThemeSwitcher.jsx';
import StructureGuide from './StructureGuide.jsx';

const NAV_ITEMS = [
  { id: 'floor', label: 'Build floor', icon: IconFloor },
  { id: 'docs', label: 'Docs', icon: IconDocs },
  { id: 'profile', label: 'Profile', icon: IconProfile },
  { id: 'settings', label: 'Settings', icon: IconSettings },
];

export default function Sidebar({
  collapsed,
  onToggleCollapsed,
  section,
  onSelectSection,
  user,
  onLogout,
  theme,
  onThemeChange,
  onReplayIntro,
}) {
  return (
    <aside
      className={`sidebar${collapsed ? ' collapsed' : ''}`}
      aria-label="Navigation"
    >
      <div className="sidebar-top">
        <div className="sidebar-brand">
          <BrandMark size={18} />
          {!collapsed && <span>apkit</span>}
        </div>
        <button
          type="button"
          className="sidebar-collapse-btn"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <IconChevron flipped={collapsed} />
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Sections">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`sidebar-nav-item${section === item.id ? ' active' : ''}`}
            onClick={() => onSelectSection(section === item.id ? null : item.id)}
            title={collapsed ? item.label : undefined}
            aria-current={section === item.id}
          >
            <item.icon />
            {!collapsed && <span>{item.label}</span>}
          </button>
        ))}
      </nav>

      {!collapsed && section && (
        <div className="sidebar-section-body hide-scrollbar">
          {section === 'floor' && <FloorTips />}
          {section === 'docs' && <DocsSection />}
          {section === 'profile' && <ProfileSection user={user} onLogout={onLogout} />}
          {section === 'settings' && (
            <SettingsSection theme={theme} onThemeChange={onThemeChange} onReplayIntro={onReplayIntro} />
          )}
        </div>
      )}
    </aside>
  );
}

function FloorTips() {
  return (
    <div className="sidebar-panel">
      <div className="sidebar-panel-title">Quick tips</div>
      <ul className="sidebar-tip-list">
        <li>Drop as many .zip archives as you like — each one builds in its own container.</li>
        <li>Android permissions are confirmed per upload, right before the build starts.</li>
        <li>A build that fails opens a help panel on the right with troubleshooting.</li>
      </ul>
    </div>
  );
}

function DocsSection() {
  const [open, setOpen] = useState('structure-guide');
  return (
    <div className="sidebar-panel">
      <div className="sidebar-panel-title">Docs</div>
      <div className="docs-list">
        <button
          type="button"
          className={`docs-list-item${open === 'structure-guide' ? ' open' : ''}`}
          onClick={() => setOpen(open === 'structure-guide' ? null : 'structure-guide')}
          aria-expanded={open === 'structure-guide'}
        >
          <span className={`log-toggle-caret${open === 'structure-guide' ? ' open' : ''}`} aria-hidden="true">▸</span>
          Project structure guide
        </button>
        {open === 'structure-guide' && (
          <div className="docs-list-body">
            <StructureGuide />
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileSection({ user, onLogout }) {
  return (
    <div className="sidebar-panel">
      <div className="sidebar-panel-title">Profile</div>
      <div className="profile-card">
        <div className="profile-avatar" aria-hidden="true">
          {(user?.email || '?').slice(0, 1).toUpperCase()}
        </div>
        <div className="profile-email" title={user?.email}>{user?.email || 'Unknown'}</div>
      </div>
      <button type="button" className="sidebar-danger-btn" onClick={onLogout}>
        Sign out
      </button>
    </div>
  );
}

function SettingsSection({ theme, onThemeChange, onReplayIntro }) {
  return (
    <div className="sidebar-panel">
      <div className="sidebar-panel-title">Settings</div>

      <div className="settings-group">
        <div className="settings-label">Color theme</div>
        <ThemeSwitcher theme={theme} onChange={onThemeChange} vertical />
      </div>

      <div className="settings-group">
        <div className="settings-label">Onboarding</div>
        <button type="button" className="sidebar-link-btn" onClick={onReplayIntro}>
          Show the welcome intro again
        </button>
      </div>
    </div>
  );
}

function IconChevron({ flipped }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ transform: flipped ? 'rotate(180deg)' : 'none' }}>
      <path d="M10 3 5.5 8l4.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconFloor() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.5" y="4" width="15" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 8h15" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
function IconDocs() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M5 3h7l3 3v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M7 9h6M7 12h6M7 15h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function IconProfile() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="7" r="3.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.5 17c1-3.4 4-5 6.5-5s5.5 1.6 6.5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
function IconSettings() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M10 3.5v1.3M10 15.2v1.3M16.5 10h-1.3M4.8 10H3.5M14.6 5.4l-.9.9M6.3 13.7l-.9.9M14.6 14.6l-.9-.9M6.3 6.3l-.9-.9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
