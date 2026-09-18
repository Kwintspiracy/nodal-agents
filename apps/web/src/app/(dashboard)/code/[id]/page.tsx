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
import StatusPill from '@/components/ui/StatusPill';
import { threadSubtitle } from '@/app/(dashboard)/spaces/format.ts';
import { truncate } from '@/lib/format-time';
import { plainText } from '@/components/Markdown.tsx';
import CodeProcessDetail from './CodeProcessDetail.tsx';
import { codeAgents, codeFilesHref, codeStatus } from './code-run-view.ts';

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
  const status = codeStatus(header.stage);

  return (
    <RunScreen
      avatarName={agentName}
      title={agentName !== '' ? `${agentName} · ${title}` : title}
      subtitle={threadSubtitle('code', at)}
      back={{ label: 'Back to Code', href: '/code' }}
      agents={codeAgents(header, activity)}
      // La barre de la maquette, au complet : le retour, les agents, le
      // dossier, la preuve, l'état. La pastille d'état est rendue par le
      // SERVEUR et reste fraîche parce que la page se relit d'elle-même tant
      // que le process court (`LiveRefresh`, dans le corps) — c'est ce qui a
      // remplacé la sonde côté client, laquelle ne rafraîchissait que le corps
      // et laissait cette barre sur l'état du chargement.
      status={<StatusPill variant={status.variant} label={status.label} />}
      // Le dossier du projet, quand le process en a un d'ENREGISTRÉ. Un dossier
      // jamais déclaré n'a pas de page : pas de bouton plutôt qu'un lien mort.
      filesHref={codeFilesHref(header)}
      proofVerdict={lastProof?.verdict ?? null}
    >
      <CodeProcessDetail detail={result.data} />
    </RunScreen>
  );
}
