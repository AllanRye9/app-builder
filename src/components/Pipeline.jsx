const STAGES = [
  { key: 'validating', label: 'Validate' },
  { key: 'building', label: 'Build' },
  { key: 'success', label: 'Ready' },
];

const ORDER = STAGES.map((s) => s.key);

export default function Pipeline({ activeStage, failed }) {
  const effectiveStage = activeStage === 'queued' || activeStage === 'uploading' ? 'validating' : activeStage;
  const activeIndex = ORDER.indexOf(effectiveStage);

  return (
    <div className="pipeline" role="list" aria-label="Build stages">
      {STAGES.map((stage, i) => {
        let state = '';
        if (failed && i === activeIndex) state = 'failed';
        else if (i < activeIndex) state = 'done';
        else if (i === activeIndex) state = activeStage === 'success' ? 'done' : 'active';

        return (
          <div key={stage.key} role="listitem" className={`step ${state}`}>
            <span className="step-dot">{state === 'done' ? '✓' : state === 'failed' ? '!' : ''}</span>
            <span className="step-label">{stage.label}</span>
            {i < STAGES.length - 1 && <span className="step-rule" aria-hidden="true" />}
          </div>
        );
      })}
    </div>
  );
}
