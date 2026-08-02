import { useEffect, useState } from 'react';
import { fetchSystemStatus } from '../api.js';

const POLL_MS = 4000;

// A single, standing read on the container's *real* capacity — distinct
// from App.jsx's per-job stats-bar (which only summarizes the jobs this
// browser tab happens to know about). This polls the server directly, so
// it stays accurate even for load this tab didn't create, and gives a
// visible answer to "why isn't my build starting yet" (queued behind
// MAX_CONCURRENT_BUILDS vs. waiting on free memory) instead of a build
// silently sitting in 'queued'.
export default function SystemStatusBar() {
  const [sys, setSys] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer;

    async function poll() {
      try {
        const data = await fetchSystemStatus();
        if (!cancelled) {
          setSys(data);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (failed || !sys) return null;

  const usedPct = Math.min(100, Math.round((sys.memory.usedMb / sys.memory.totalMb) * 100));
  const slotsUsed = sys.running;
  const slotsTotal = sys.maxConcurrentBuilds;

  return (
    <div className={`sys-bar${sys.memory.lowMemory ? ' sys-bar-low' : ''}`} aria-label="Build worker capacity">
      <div className="sys-bar-item">
        <span className="sys-bar-dot sys-bar-dot-active" aria-hidden="true" />
        <span className="sys-bar-label">
          {slotsUsed}/{slotsTotal} build slot{slotsTotal === 1 ? '' : 's'} in use
        </span>
      </div>

      {sys.queued > 0 && (
        <div className="sys-bar-item">
          <span className="sys-bar-dot sys-bar-dot-queued" aria-hidden="true" />
          <span className="sys-bar-label">{sys.queued} waiting</span>
        </div>
      )}

      <div className="sys-bar-item sys-bar-mem" title={`${sys.memory.freeMb}MB free of ${sys.memory.totalMb}MB`}>
        <span className="sys-bar-label">Memory</span>
        <div className="sys-bar-mem-track">
          <div
            className={`sys-bar-mem-fill${sys.memory.lowMemory ? ' low' : ''}`}
            style={{ width: `${usedPct}%` }}
          />
        </div>
        <span className="sys-bar-mem-value">{usedPct}%</span>
      </div>

      {sys.memory.lowMemory && (
        <div className="sys-bar-item sys-bar-warning">
          Low memory — new builds will wait for headroom before starting
        </div>
      )}
    </div>
  );
}
