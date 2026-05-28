'use client';

import { useRouter } from 'next/navigation';

interface AgentsErrorRetryProps {
  message: string;
}

export default function AgentsErrorRetry({ message }: AgentsErrorRetryProps) {
  const router = useRouter();

  return (
    <div className="bg-warn-bg border border-err/30 rounded-xl px-5 py-4 flex items-center justify-between gap-4">
      <p className="text-sm text-err">{message}</p>
      <button
        onClick={() => router.refresh()}
        className="shrink-0 px-3 py-1.5 text-xs font-medium border border-err/30 text-err rounded-lg hover:border-err hover:text-err transition-colors"
      >
        Retry
      </button>
    </div>
  );
}
