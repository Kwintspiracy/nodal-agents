'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeSlash } from '@phosphor-icons/react';
import PillTabs from '@/components/ui/PillTabs';
import TextInput from '@/components/ui/TextInput';
import IconButton from '@/components/ui/IconButton';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { claimOwnerAccountAction } from '@/lib/actions.ts';
import type { AuthSetupState } from '@nodal-agents/auth';

type Mode = 'signin' | 'signup';

interface Props {
  /** Which flow can succeed on this install — resolved server-side. */
  setup: AuthSetupState;
  /** True when NODALAI_ALLOW_OPEN_SIGNUP=1 keeps sign-up open past the first user. */
  openSignup: boolean;
}

/**
 * Email+password form. Used when AUTH_MODE=local-auth. Renders one of:
 *   - 'claim': owner-account creation for an install migrated from local-trust
 *     (a user exists, no password) — sign-up is closed, sign-in impossible.
 *   - 'fresh': sign-up first (no user exists yet).
 *   - 'ready': sign-in; the sign-up tab only shows when it can succeed.
 * Posts to better-auth endpoints at /api/auth/sign-in/email and /api/auth/sign-up/email.
 */
export default function AuthLoginForm({ setup, openSignup }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(setup === 'fresh' ? 'signup' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);

  const isClaim = setup === 'claim';
  const showSignupTab = setup === 'fresh' || openSignup;

  function resetMode(next: Mode) {
    setMode(next);
    setError('');
    setInfo('');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
  }

  async function signIn(emailArg: string, passwordArg: string): Promise<boolean> {
    const res = await fetch('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailArg, password: passwordArg }),
    });
    return res.ok;
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      if (await signIn(email, password)) {
        router.push('/');
      } else {
        setError('Invalid email or password.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function validatePasswordPair(): boolean {
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return false;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return false;
    }
    return true;
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    if (!validatePasswordPair()) return;
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
        setInfo('Account created. You can sign in now.');
        resetMode('signin');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleClaim(e: React.FormEvent) {
    e.preventDefault();
    if (!validatePasswordPair()) return;
    setLoading(true);
    setError('');
    try {
      const r = await claimOwnerAccountAction({ email, password });
      if (!r.ok) {
        setError(r.message);
        return;
      }
      // Credential created — sign in with it right away.
      if (await signIn(email, password)) {
        router.push('/');
      } else {
        setInfo('Account created. Sign in to continue.');
        setError('');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  const submitHandler = isClaim ? handleClaim : mode === 'signin' ? handleSignIn : handleSignUp;
  const needsConfirm = isClaim || mode === 'signup';

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-1.5 mb-6">
            <span className="text-ok font-mono text-sm">$</span>
            <span className="text-sm font-mono font-bold text-ink tracking-tight">
              nodal-agents
            </span>
          </div>
          <h1 className="text-2xl font-bold text-ink tracking-tight">
            {isClaim ? 'Create your account' : 'Welcome'}
          </h1>
          <p className="text-sm text-ink-3 mt-1">
            {isClaim
              ? 'Sign-in is now required. Set the owner email and password. Your agents, settings and history stay as they are.'
              : showSignupTab
                ? 'Sign in or create an account to continue'
                : 'Sign in to continue'}
          </p>
        </div>

        {!isClaim && showSignupTab && (
          <PillTabs
            tabs={[
              { value: 'signin', label: 'Sign in' },
              { value: 'signup', label: 'Create account' },
            ]}
            value={mode}
            onChange={(v) => resetMode(v as Mode)}
            variant="inset"
            fullWidth
            className="mb-6 border border-rule-2"
          />
        )}

        <div className="rounded-2xl border border-rule-2 bg-paper/60 p-6 space-y-4">
          <form onSubmit={submitHandler} className="space-y-3">
            <div>
              <label className="block text-xs text-ink-3 mb-1.5">Email address</label>
              <TextInput
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoFocus
                data-testid="email-input"
                className="rounded-lg border-rule-2 bg-hover py-2.5 focus:border-rule"
              />
            </div>

            <div>
              <label className="block text-xs text-ink-3 mb-1.5">Password</label>
              <div className="relative">
                <TextInput
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  data-testid="password-input"
                  className="rounded-lg border-rule-2 bg-hover py-2.5 pr-10 focus:border-rule"
                />
                <IconButton
                  ghost
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink-2"
                >
                  {showPassword ? <EyeSlash size={15} /> : <Eye size={15} />}
                </IconButton>
              </div>
            </div>

            {needsConfirm && (
              <div>
                <label className="block text-xs text-ink-3 mb-1.5">Confirm password</label>
                <TextInput
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  data-testid="confirm-password-input"
                  className="rounded-lg border-rule-2 bg-hover py-2.5 focus:border-rule"
                />
              </div>
            )}

            {error && (
              <p className="text-xs text-err" data-testid="login-error">
                {error}
              </p>
            )}

            {info && <p className="text-xs text-ok">{info}</p>}

            <PrimaryButton
              variant="agent"
              type="submit"
              disabled={loading}
              data-testid="login-button"
              className="mt-1 w-full"
            >
              {loading
                ? '…'
                : isClaim
                  ? 'Create account and sign in'
                  : mode === 'signin'
                    ? 'Sign in'
                    : 'Create account'}
            </PrimaryButton>
          </form>
        </div>
      </div>
    </div>
  );
}
