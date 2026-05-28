'use client';

import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';

type Theme = 'light' | 'dark';

function readTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/**
 * ThemedToaster — Sonner Toaster wired to the same `data-theme` attribute
 * the rest of the app uses. Sonner's built-in `theme="system"` reads
 * `prefers-color-scheme`, which would mismatch when the user explicitly
 * picks a non-system theme. This wrapper observes the attribute directly
 * and re-renders the toaster so toasts always match the shell.
 */
export default function ThemedToaster() {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    // Initial hydration read — data-theme was set by the inline bootstrap
    // script in <head> before React mounted. The MutationObserver picks up
    // every subsequent toggle so toasts always match the live theme.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(readTheme());
    const obs = new MutationObserver(() => setTheme(readTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  return <Toaster theme={theme} position="bottom-right" richColors closeButton />;
}
