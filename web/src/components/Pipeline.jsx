const STAGES = [
  { key: 'validating', label: 'Validate' },
  { key: 'queued', label: 'Queue' },
  { key: 'building', label: 'Build' },
  { key: 'success', label: 'Ready' },
];

const ORDER = STAGES.map((s) => s.key);

// Compact horizontal stepper — sized to sit inside a ticket-width job card
// rather than a full-page vertical list, since a dashboard now shows many
// of these stacked at once.
// buildStep/buildProgress/cacheHit carry the fine-grained detail emitted by
// setStep() in src/jobStore.js (e.g. "Compiling APK with Gradle", 65%) —
// distinct from activeStage, which only ever holds one of the 4 macro
// stages above. Showing both together is the point: the macro stepper says
// *where* in the pipeline a build is, the detail line + bar says *what's
// actually happening right now* and roughly how far along it is, instead of
// "Build" sitting there unchanged for however many minutes Gradle takes.
export default function Pipeline({ activeStage, failed, queuePosition, buildStep, buildProgress, cacheHit }) {
  const activeIndex = ORDER.indexOf(activeStage);

  return (
    <div className="pipeline-wrap">
      <div className="pipeline" role="list" aria-label="Build stages">
        {STAGES.map((stage, i) => {
          let state = '';
          if (failed && i === activeIndex) state = 'failed';
          else if (i < activeIndex) state = 'done';
          else if (i === activeIndex) state = activeStage === 'success' ? 'done' : 'active';

          const showPosition = state === 'active' && stage.key === 'queued' && queuePosition > 0;

          return (
            <div key={stage.key} role="listitem" className={`step ${state}`}>
              <span className="step-dot">{state === 'done' ? '✓' : state === 'failed' ? '!' : ''}</span>
              <span className="step-label">
                {showPosition ? `${ordinal(queuePosition)} in line` : stage.label}
              </span>
              {i < STAGES.length - 1 && <span className="step-rule" aria-hidden="true" />}
            </div>
          );
        })}
      </div>

      {activeStage === 'building' && !failed && buildStep && (
        <div className="pipeline-detail">
          <div className="pipeline-detail-row">
            <span className="pipeline-detail-label">{buildStep}</span>
            {cacheHit && <span className="cache-badge" title="Reused a previously installed dependency tree — no re-download or re-install needed">⚡ cache hit</span>}
          </div>
          <div className="pipeline-detail-bar" role="progressbar" aria-valuenow={buildProgress || 0} aria-valuemin={0} aria-valuemax={100}>
            <div className="pipeline-detail-fill" style={{ width: `${Math.max(4, buildProgress || 0)}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
