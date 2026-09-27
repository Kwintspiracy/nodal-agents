'use client';

import { useRouter } from 'next/navigation';
import Banner from '@/components/ui/Banner';
import PrimaryButton from '@/components/ui/PrimaryButton';

interface AgentsErrorRetryProps {
  message: string;
}

export default function AgentsErrorRetry({ message }: AgentsErrorRetryProps) {
  const router = useRouter();

  return (
    <Banner
      variant="warn"
      action={
        <PrimaryButton variant="neutral" size="sm" onClick={() => router.refresh()}>
          Retry
        </PrimaryButton>
      }
    >
      {message}
    </Banner>
  );
}
