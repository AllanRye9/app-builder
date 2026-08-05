import { useEffect, useState } from 'react';
import { pingVisitor, fetchVisitorStats } from '../api.js';

// Refreshes so the numbers stay live while the tab is open (other people's
// visits show up without a reload) — the ping that actually records this
// visitor only ever fires once, on mount.
const POLL_MS = 30000;

export default function VisitorStats() {
  const [stats, setStats] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer;

    async function poll() {
      try {
        const data = await fetchVisitorStats();
        if (!cancelled) {
          setStats(data);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    }

    // Record this visitor once, then switch to read-only polling for
    // subsequent refreshes — a page just sitting open shouldn't keep
    // re-counting the same visit.
    pingVisitor()
      .then((data) => {
        if (cancelled) return;
        setStats(data);
        timer = setTimeout(poll, POLL_MS);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        timer = setTimeout(poll, POLL_MS);
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (failed && !stats) return null;
  if (!stats) return null;

  return (
    <div className="visitor-bar" aria-label="Visitor analytics">
      <VisitorStat value={stats.totalVisitors} label="total visitors" tone="copper" />
      <span className="visitor-bar-rule" aria-hidden="true" />
      <VisitorStat value={stats.todayVisitors} label="today" tone="teal" />
      <span className="visitor-bar-rule" aria-hidden="true" />
      <VisitorStat value={stats.countries} label={stats.countries === 1 ? 'country reached' : 'countries reached'} tone="violet" />
    </div>
  );
}

function VisitorStat({ value, label, tone }) {
  return (
    <div className={`visitor-stat visitor-stat-${tone}`}>
      <span className="visitor-stat-value">{value.toLocaleString()}</span>
      <span className="visitor-stat-label">{label}</span>
    </div>
  );
}
