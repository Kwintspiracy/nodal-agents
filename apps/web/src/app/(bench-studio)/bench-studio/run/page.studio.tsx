// Run — choisir des activités ou des scénarios, des modèles, un nombre d'essais ; estimer.
// Lancer attend #769 : le bouton est désactivé, et le serveur n'a pas de route de lancement.
import { LAUNCH_DISABLED_REASON, studioCatalog } from '@nodal-agents/bench/studio';
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
  // Les modèles que l'espace du banc peut appeler : ses fournisseurs de clés LLM.
  const models = await studioRuntime().models();
  return (
    <StudioPage
      title="Run"
      subtitle="Pick what to run and estimate its cost and time. Launching waits for the bench space (#769)."
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
        models={models}
        launchDisabledReason={LAUNCH_DISABLED_REASON}
        initialOnly={only ? only.split(',').filter(Boolean) : []}
      />
    </StudioPage>
  );
}
