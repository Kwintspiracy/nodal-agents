import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getCodingProcessDetailAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import CodeProcessDetail from './CodeProcessDetail.tsx';

// Force dynamic — this page reads per-request DB state.
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

/**
 * The route param is `<kind>-<rawId>` (built by CodeProcessesTable's
 * processHref) so a job id and a chat session id — both plausibly UUID-shaped
 * — never get confused for one another. Anything else 404s.
 */
function parseRouteId(raw: string): { jobId: string } | { sessionId: string } | null {
  if (raw.startsWith('job-')) {
    const jobId = raw.slice('job-'.length);
    return jobId ? { jobId } : null;
  }
  if (raw.startsWith('chat-')) {
    const sessionId = raw.slice('chat-'.length);
    return sessionId ? { sessionId } : null;
  }
  return null;
}

export default async function CodeProcessPage({ params }: Props) {
  const { id } = await params;
  const parsedId = parseRouteId(id);
  if (!parsedId) notFound();

  const result = await getCodingProcessDetailAction(parsedId);

  if (!result.ok) {
    if (result.code === 'not_found') notFound();
    return (
      <PageShell title="Code">
        <div className="space-y-4">
          <Link href="/code" className="text-body-13 text-ink-3 hover:text-ink-2">
            ← Code
          </Link>
          <p className="text-body-14 text-err">{result.message}</p>
        </div>
      </PageShell>
    );
  }

  const { header } = result.data;

  return (
    <PageShell title={header.agentName ?? 'Coding process'} subtitle={header.id}>
      <CodeProcessDetail query={parsedId} initialDetail={result.data} />
    </PageShell>
  );
}
