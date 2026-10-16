// Un lancement en direct : une ligne par essai, son étape, son temps, son arbre de jobs.
import { notFound } from 'next/navigation';
import { stackWebUrl } from '@nodal-agents/bench/studio';
import { assertStudioPage, studioRuntime } from '@/lib/bench-studio/server';
import StudioPage from '../../_components/StudioPage';
import LiveRun from './LiveRun';

export const dynamic = 'force-dynamic';

export default async function LiveRunPage({ params }: { params: Promise<{ id: string }> }) {
  await assertStudioPage();
  const { id } = await params;
  const run = studioRuntime().manager.get(id);
  if (!run) notFound();
  return (
    <StudioPage
      title={id}
      subtitle={`Started ${new Date(run.startedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC · ${run.request.trials} trial(s) per scenario${run.request.allowOwnerSends ? ' · sends to the owner allowed' : ''}`}
    >
      <LiveRun id={id} webUrl={stackWebUrl()} />
    </StudioPage>
  );
}
