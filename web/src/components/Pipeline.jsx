const STAGES = [
  { key: 'validating', label: 'Validating archive' },
  { key: 'queued', label: 'Queued for build' },
  { key: 'building', label: 'Building in container' },
  { key: 'success', label: 'APK ready' },
];

const ORDER = STAGES.map((s) => s.key);

export default function Pipeline({ activeStage, failed }) {
  const activeIndex = ORDER.indexOf(activeStage);

  return (
    <div className="pipeline">
      {STAGES.map((stage, i) => {
        let state = '';
        if (failed && i === activeIndex) state = 'failed';
        else if (i < activeIndex) state = 'done';
        else if (i === activeIndex) state = activeStage === 'success' ? 'done' : 'active';

        return (
          <div key={stage.key} className={`stage-row ${state}`}>
            <div className="dot">{state === 'done' ? '✓' : ''}</div>
            <div className="stage-label">{stage.label}</div>
          </div>
        );
      })}
    </div>
  );
}
