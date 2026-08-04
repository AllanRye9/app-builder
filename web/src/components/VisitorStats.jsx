import { useEffect, useState } from 'react';
import CountUp from './CountUp.jsx';
import { pingVisitor, fetchVisitorStats } from '../api.js';
import { getVisitorId } from '../lib/visitor.js';

// Pings the server exactly once per mount (StrictMode double-invoke aside,
// production only mounts this once) so a repeat reload of the same tab
// doesn't hammer the endpoint — the count itself is already deduped
// server-side by visitorId regardless.
export default function VisitorStats() {
  const [stats, setStats] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    pingVisitor(getVisitorId())
      .then((data) => { if (!cancelled) setStats(data); })
      .catch(() =>
        fetchVisitorStats()
          .then((data) => { if (!cancelled) setStats(data); })
          .catch(() => { if (!cancelled) setFailed(true); })
      );
    return () => { cancelled = true; };
  }, []);

  if (failed) return null;

  return (
    <div className="visitor-stats" aria-label="Visitor statistics" aria-live="off">
      <VisitorStat label="total visitors" value={stats?.total} glyph="👥" />
      <span className="visitor-sep" aria-hidden="true" />
      <VisitorStat label="today" value={stats?.today} glyph="📅" />
      <span className="visitor-sep" aria-hidden="true" />
      <VisitorStat label="countries reached" value={stats?.countries} glyph="🌍" />
    </div>
  );
}

function VisitorStat({ label, value, glyph }) {
  return (
    <div className="visitor-stat">
      <span className="visitor-glyph" aria-hidden="true">{glyph}</span>
      <span className="visitor-value">
        {value === undefined ? <span className="visitor-skel" /> : <CountUp value={value} />}
      </span>
      <span className="visitor-label">{label}</span>
    </div>
  );
}
