'use client';

import { useRouter } from 'next/navigation';
import PrimaryButton from '@/components/ui/PrimaryButton';

interface AgentsErrorRetryProps {
  message: string;
}

export default function AgentsErrorRetry({ message }: AgentsErrorRetryProps) {
  const router = useRouter();

  return (
    <div className="bg-warn-bg border border-err/30 rounded-xl px-5 py-4 flex items-center justify-between gap-4">
      <p className="text-sm text-err">{message}</p>
      <PrimaryButton
        variant="danger"
        size="sm"
        className="shrink-0"
        onClick={() => router.refresh()}
      >
        Retry
      </PrimaryButton>
    </div>
  );
}
