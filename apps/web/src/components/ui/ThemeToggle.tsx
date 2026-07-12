'use client';

import { useEffect, useState } from 'react';
import { Sun, Moon } from '@phosphor-icons/react';
import IconButton from './IconButton';

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'nodal.theme';

function readTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'dark' ? 'dark' : 'light';
}

/**
 * ThemeToggle — sun/moon button in the topbar. Mutates the `data-theme`
 * attribute on `<html>` and persists the choice under the same key the
 * inline bootstrap script reads on page load (`nodal.theme`). One source
 * of truth, no flash on reload.
 */
export default function ThemeToggle() {
  // SSR renders the icon for the bootstrap-applied theme. Until React hydrates
  // we don't actually know what theme is in the DOM (the bootstrap ran
  // client-side), so we read it once on mount and re-render.
  const [theme, setTheme] = useState<Theme>('light');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // SSR-safe hydration: the inline bootstrap in <head> set data-theme before
    // React mounted, so we read it once here and re-render with the live value.
    // Same pattern as ConfirmDialog.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(readTheme());
    setReady(true);
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage blocked — fail soft, in-memory state still flips.
    }
    setTheme(next);
  };

  const Icon = theme === 'dark' ? Sun : Moon;
  const aria = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <IconButton
      onClick={toggle}
      aria-label={aria}
      title={aria}
      // Avoid a hydration mismatch if the bootstrap script set a non-default theme.
      suppressHydrationWarning
    >
      {/* Until we've read the live data-theme on mount, render whichever icon
          matches the SSR default (light → Moon). After mount, the real one. */}
      {ready ? <Icon size={15} /> : <Moon size={15} />}
    </IconButton>
  );
}
