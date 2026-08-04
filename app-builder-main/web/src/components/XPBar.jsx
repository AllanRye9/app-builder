import { useState } from 'react';
import CountUp from './CountUp.jsx';
import { levelProgress, BADGES } from '../lib/gamification.js';

export default function XPBar({ progress }) {
  const [open, setOpen] = useState(false);
  const { level, pct, maxed } = levelProgress(progress.xp);
  const earnedIds = new Set(progress.badges);

  return (
    <div className="xp-panel">
      <button type="button" className="xp-summary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="xp-level" title={`Level ${level}`}>
          Lv <CountUp value={level} duration={500} />
        </span>
        <span className="xp-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span className="xp-fill" style={{ width: `${maxed ? 100 : pct}%` }} />
        </span>
        <span className="xp-value"><CountUp value={progress.xp} /> XP</span>
        {progress.badges.length > 0 && (
          <span className="xp-badge-count">{progress.badges.length}/{BADGES.length} badges</span>
        )}
        <span className={`log-toggle-caret${open ? ' open' : ''}`} aria-hidden="true">▸</span>
      </button>

      <div className={`xp-badges-wrap${open ? ' open' : ''}`}>
        <div className="xp-badges">
          <div className="xp-badges-inner">
            {BADGES.map((b) => (
              <div key={b.id} className={`xp-badge${earnedIds.has(b.id) ? ' earned' : ''}`} title={b.desc}>
                <span className="xp-badge-glyph" aria-hidden="true">{b.glyph}</span>
                <span className="xp-badge-label">{b.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
