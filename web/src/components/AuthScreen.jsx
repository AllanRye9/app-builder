import { useState } from 'react';
import BrandMark from './BrandMark.jsx';
import { signup, login } from '../api.js';

export default function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const fn = mode === 'signup' ? signup : login;
      const data = await fn(email, password);
      onAuthenticated(data.token, data.user);
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-frame">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark size={22} />
          <span>apkit</span>
        </div>
        <h1 className="auth-title">{mode === 'signup' ? 'Create your account' : 'Sign in'}</h1>
        <p className="auth-sub">
          {mode === 'signup'
            ? 'Set up an account to start turning project archives into APKs.'
            : 'Sign in to reach the build floor.'}
        </p>

        <form className="auth-form" onSubmit={submit}>
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
              minLength={8}
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
          onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError(''); }}
        >
          {mode === 'signup' ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
        </button>
      </div>
    </div>
  );
}
