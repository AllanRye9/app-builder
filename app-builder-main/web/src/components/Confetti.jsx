import { useEffect, useState } from 'react';

const COLORS = ['var(--copper)', 'var(--teal)', 'var(--violet)', 'var(--coral)'];
const COUNT = 26;

// Self-contained: mount it, it plays once, it removes itself. No timers or
// state to manage from the caller beyond deciding when to mount a fresh
// key (App.jsx uses a bumping key so re-triggering restarts the burst).
export default function Confetti() {
  const [pieces] = useState(() =>
    Array.from({ length: COUNT }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.25,
      duration: 1.1 + Math.random() * 0.6,
      rotate: Math.random() * 360,
      color: COLORS[i % COLORS.length],
      drift: (Math.random() - 0.5) * 60,
    }))
  );

  useEffect(() => {
    // No cleanup needed for the pieces themselves (CSS animation just
    // finishes and they sit invisible) — the parent unmounts this
    // component after the animation window closes.
  }, []);

  return (
    <div className="confetti-layer" aria-hidden="true">
      {pieces.map((p) => (
        <span
          key={p.id}
          className="confetti-piece"
          style={{
            left: `${p.left}%`,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            '--rotate': `${p.rotate}deg`,
            '--drift': `${p.drift}px`,
            background: p.color,
          }}
        />
      ))}
    </div>
  );
}
