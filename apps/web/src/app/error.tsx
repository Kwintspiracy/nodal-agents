'use client';

import { useEffect } from 'react';
import PrimaryButton from '@/components/ui/PrimaryButton';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-canvas px-4">
      <div className="max-w-sm space-y-4 text-center">
        <h1 className="text-2xl font-bold text-ink">Something went wrong</h1>
        {/* Never show the raw error.message to the user — it leaks internals and
            reads as a dev crash. The real error is logged to the console above. */}
        <p className="text-sm text-ink-3">
          An unexpected error occurred. Try again, or refresh the page — the details have been
          logged.
        </p>
        <PrimaryButton variant="agent" onClick={reset}>
          Try again
        </PrimaryButton>
        {error.digest && <p className="text-mono-12 text-ink-4">Reference: {error.digest}</p>}
      </div>
    </div>
  );
}
