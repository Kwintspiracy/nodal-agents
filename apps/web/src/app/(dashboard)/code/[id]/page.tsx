// /code/[id] — LE RUN D'UN PROCESS DE CODE.
//
// 18/09 — la troisième route qui montre un run, et la dernière à se poser sur
// la charpente commune (`RunScreen`) : les deux barres du fil en haut, le corps
// qui défile dessous, et dans ce corps les mêmes blocs que `/scheduled/[id]` et
// `/jobs/[id]`, dans le même ordre.
//
// Ce que cette route décide, et qu'elle est seule à savoir : d'où l'on vient
// (Code), qui a travaillé, et ce que dit la preuve. Le CORPS, lui, est vivant :
// il se relit tout seul tant que le process court (`CodeProcessDetail`).

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getCodingProcessDetailAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import RunScreen from '@/app/(dashboard)/runs/RunScreen.tsx';
import { threadSubtitle } from '@/app/(dashboard)/spaces/format.ts';
import { truncate } from '@/lib/format-time';
import { plainText } from '@/components/Markdown.tsx';
import CodeProcessDetail from './CodeProcessDetail.tsx';
import { codeAgents } from './code-run-view.ts';

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

  const { header, activity, verificationRuns } = result.data;
  const agentName = header.agentName ?? '';
  const title = truncate(plainText(header.task), 60);
  const lastProof = verificationRuns.at(-1) ?? null;
  // La seule date que ce détail porte est celle de sa dernière activité.
  const at = header.activityAt === null ? null : new Date(header.activityAt);

  return (
    <RunScreen
      avatarName={agentName}
      title={agentName !== '' ? `${agentName} · ${title}` : title}
      subtitle={threadSubtitle('code', at)}
      back={{ label: 'Back to Code', href: '/code' }}
      agents={codeAgents(header, activity)}
      proofVerdict={lastProof?.verdict ?? null}
      // PAS de pastille d'état dans la barre : elle est rendue UNE fois, par le
      // serveur, tandis que le corps se relit tout seul toutes les quatre
      // secondes. Sur un process vivant, la pastille aurait figé « Coding »
      // au-dessus d'une carte disant « Done » — un écran qui se contredit est
      // pire qu'un écran qui se tait. L'état vit donc dans la carte de tête, où
      // il est toujours frais.
    >
      <CodeProcessDetail query={parsedId} initialDetail={result.data} />
    </RunScreen>
  );
}
