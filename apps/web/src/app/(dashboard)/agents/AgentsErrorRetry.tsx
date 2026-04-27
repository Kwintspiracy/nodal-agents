'use client';

import { useRouter } from 'next/navigation';

interface AgentsErrorRetryProps {
  message: string;
}

export default function AgentsErrorRetry({ message }: AgentsErrorRetryProps) {
  const router = useRouter();

  return (
    <div className="bg-red-950/40 border border-red-800/50 rounded-xl px-5 py-4 flex items-center justify-between gap-4">
      <p className="text-sm text-red-400">{message}</p>
      <button
        onClick={() => router.refresh()}
        className="shrink-0 px-3 py-1.5 text-xs font-medium border border-red-700/50 text-red-400 rounded-lg hover:border-red-600 hover:text-red-300 transition-colors"
      >
        Retry
      </button>
    </div>
  );
}
