import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="screen">
      <h1>Sample App</h1>
      <p>If you can see this and tap the button, the APK built correctly.</p>
      <button onClick={() => setCount((c) => c + 1)}>
        Tapped {count} time{count === 1 ? '' : 's'}
      </button>
    </div>
  );
}
