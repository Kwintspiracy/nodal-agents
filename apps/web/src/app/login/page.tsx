'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeSlash } from '@phosphor-icons/react';

// ─── Local-trust mode banner ───────────────────────────────────────────────────
// When AUTH_MODE=local-trust (the default), there's no real auth — the server
// trusts any local request. Show an informational banner and a direct entry link.

function LocalTrustBanner() {
  const router = useRouter();
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-neutral-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-1.5 mb-6">
            <span className="text-emerald-500 font-mono text-sm">$</span>
            <span className="text-sm font-mono font-bold text-white tracking-tight">nodalai</span>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Local mode active</h1>
          <p className="text-sm text-neutral-500 mt-1">
            No authentication required in local-trust mode.
          </p>
        </div>
        <div className="rounded-2xl border border-neutral-800/50 bg-neutral-900/50 p-6 space-y-4 text-center">
          <p className="text-xs text-neutral-400">
            You are running NodalAI in <code className="text-emerald-400">local-trust</code> mode.
            Set <code className="text-emerald-400">AUTH_MODE=local-auth</code> in your{' '}
            <code className="text-neutral-300">.env</code> to enable email + password
            authentication.
          </p>
          <button
            type="button"
            onClick={() => router.push('/stats')}
            className="w-full rounded-lg bg-emerald-500 text-black py-2.5 text-sm font-semibold hover:bg-emerald-400 transition-colors"
          >
            Enter dashboard
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Auth mode detection ───────────────────────────────────────────────────────
// NEXT_PUBLIC_* vars are safe to read client-side.

const authMode =
  typeof process !== 'undefined'
    ? (process.env['NEXT_PUBLIC_AUTH_MODE'] ?? 'local-trust')
    : 'local-trust';

// ─── Login form ────────────────────────────────────────────────────────────────

type Mode = 'signin' | 'signup';

export default function LoginPage() {
  if (authMode === 'local-trust') {
    return <LocalTrustBanner />;
  }

  return <AuthLoginForm />;
}

function AuthLoginForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);

  function resetMode(next: Mode) {
    setMode(next);
    setError('');
    setInfo('');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      // POST to better-auth sign-in endpoint (local-auth mode).
      const res = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? 'Invalid email or password.');
      } else {
        router.push('/stats');
      }
    } catch {
      setError('Network error — please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name: email.split('@')[0] }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? 'Could not create account.');
      } else {
        setInfo('Account created — you can sign in now.');
        resetMode('signin');
      }
    } catch {
      setError('Network error — please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-neutral-950 px-4">
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-1.5 mb-6">
            <span className="text-emerald-500 font-mono text-sm">$</span>
            <span className="text-sm font-mono font-bold text-white tracking-tight">nodalai</span>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Welcome</h1>
          <p className="text-sm text-neutral-500 mt-1">Sign in or create an account to continue</p>
        </div>

        {/* Mode tabs */}
        <div className="flex mb-6 rounded-lg bg-neutral-900 p-1 border border-neutral-800">
          <button
            type="button"
            onClick={() => resetMode('signin')}
            className={`flex-1 py-2 text-xs font-medium rounded-md transition-colors ${
              mode === 'signin'
                ? 'bg-neutral-800 text-white'
                : 'text-neutral-500 hover:text-neutral-300'
            }`}
          >
            Sign in
          </button>
          <button
            type="button"
            onClick={() => resetMode('signup')}
            className={`flex-1 py-2 text-xs font-medium rounded-md transition-colors ${
              mode === 'signup'
                ? 'bg-neutral-800 text-white'
                : 'text-neutral-500 hover:text-neutral-300'
            }`}
          >
            Create account
          </button>
        </div>

        <div className="rounded-2xl border border-neutral-800/50 bg-neutral-900/50 p-6 space-y-4">
          <form onSubmit={mode === 'signin' ? handleSignIn : handleSignUp} className="space-y-3">
            {/* Email */}
            <div>
              <label className="block text-xs text-neutral-400 mb-1.5">Email address</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoFocus
                data-testid="email-input"
                className="w-full rounded-lg border border-neutral-800/50 bg-neutral-800/30 px-3 py-2.5 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600 transition-colors"
              />
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs text-neutral-400 mb-1.5">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  data-testid="password-input"
                  className="w-full rounded-lg border border-neutral-800/50 bg-neutral-800/30 px-3 py-2.5 pr-10 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300 transition-colors"
                >
                  {showPassword ? <EyeSlash size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {/* Confirm password — sign up only */}
            {mode === 'signup' && (
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">Confirm password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  className="w-full rounded-lg border border-neutral-800/50 bg-neutral-800/30 px-3 py-2.5 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600 transition-colors"
                />
              </div>
            )}

            {/* Error */}
            {error && (
              <p className="text-xs text-red-400" data-testid="login-error">
                {error}
              </p>
            )}

            {/* Info */}
            {info && <p className="text-xs text-emerald-400">{info}</p>}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              data-testid="login-button"
              className="w-full rounded-lg bg-emerald-500 text-black py-2.5 text-sm font-semibold hover:bg-emerald-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed mt-1"
            >
              {loading ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
