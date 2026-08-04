import { THEMES } from '../lib/theme.js';

export default function ThemeSwitcher({ theme, onChange }) {
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Color theme">
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={theme === t.id}
          className={`theme-switch-btn${theme === t.id ? ' active' : ''}`}
          onClick={() => onChange(t.id)}
          title={`${t.label} theme`}
        >
          <span className="theme-swatch" data-swatch={t.id} aria-hidden="true" />
          {t.label}
        </button>
      ))}
    </div>
  );
}
