import { useState } from 'react';
import { signup, login } from '../api.js';

// Gates the entire build floor: nothing else in App.jsx renders until this
// resolves with a valid session. Two modes (sign up / log in) toggled by a
// single link, since it's the same form shape either way.
export default function AuthGate({ onAuthenticated }) {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const action = mode === 'signup' ? signup : login;
      const data = await action(email.trim(), password);
      onAuthenticated(data.token, data.email);
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="eyebrow"><span className="dot" />apk-builder — build floor</div>
        <h1 className="auth-title">{mode === 'signup' ? 'Create an account' : 'Sign in'}</h1>
        <p className="auth-sub">
          {mode === 'signup'
            ? 'Sign up to start uploading projects and building APKs.'
            : 'Sign in to access the build floor.'}
        </p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <label className="auth-field">
            <span>Password</span>
            <input
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
              minLength={mode === 'signup' ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'signup' ? 'At least 8 characters' : '••••••••'}
            />
          </label>

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <button
          type="button"
          className="auth-switch"
          onClick={() => { setMode((m) => (m === 'signup' ? 'login' : 'signup')); setError(''); }}
        >
          {mode === 'signup' ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
        </button>
      </div>
    </main>
  );
}
