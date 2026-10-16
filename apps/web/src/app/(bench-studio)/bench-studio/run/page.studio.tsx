// Run — choisir des activités ou des scénarios, des modèles, un nombre d'essais ; estimer ; lancer.
import { studioCatalog, studioModels } from '@nodal-agents/bench/studio';
import { assertStudioPage, studioRuntime } from '@/lib/bench-studio/server';
import StudioPage from '../_components/StudioPage';
import RunPanel from './RunPanel';

export const dynamic = 'force-dynamic';

export default async function RunPage({
  searchParams,
}: {
  searchParams: Promise<{ only?: string }>;
}) {
  await assertStudioPage();
  const { only } = await searchParams;
  const catalog = studioCatalog();
  // La porte est lue à l'affichage, et tenue de nouveau par le serveur au lancement.
  const gate = studioRuntime().gate();
  return (
    <StudioPage
      title="Run"
      subtitle="Pick what to run, estimate it, then launch. Trials run one after the other on the stack."
    >
      <RunPanel
        activities={catalog.activities.filter((a) =>
          catalog.scenarios.some((s) => s.activity === a),
        )}
        scenarios={catalog.scenarios.map((s) => ({
          id: s.id,
          title: s.title,
          activity: s.activity,
          sends: s.sends,
          set: s.set,
        }))}
        models={studioModels()}
        gate={gate}
        initialOnly={only ? only.split(',').filter(Boolean) : []}
      />
    </StudioPage>
  );
}
