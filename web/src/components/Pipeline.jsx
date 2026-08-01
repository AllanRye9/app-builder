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
export default function Pipeline({ activeStage, failed, queuePosition }) {
  const activeIndex = ORDER.indexOf(activeStage);

  return (
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
  );
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
