'use client';

import { useEffect } from 'react';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-neutral-950 px-4">
      <div className="text-center space-y-4">
        <h1 className="text-2xl font-bold text-white">Something went wrong</h1>
        <p className="text-sm text-neutral-400">{error.message}</p>
        <button
          onClick={reset}
          className="rounded-lg bg-emerald-500 text-black px-4 py-2 text-sm font-semibold hover:bg-emerald-400 transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
