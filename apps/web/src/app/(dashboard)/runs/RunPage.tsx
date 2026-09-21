// RunPage — LA page d'un run, pour les deux portes qui y mènent (18/09/2026).
//
// Décision de Quentin : un run n'est pas une conversation. On ne le LIT pas du
// début à la fin, on le SUIT — d'où un tableau de bord et non un fil. La page
// garde donc, bloc pour bloc, l'ordre linéaire du détail Code (l'en-tête et ses
// chiffres, la réponse, la livraison, la revue, la preuve, l'activité),
// redessiné avec les codes graphiques du fil (#135) : cartes papier, filets
// `rule-2`, titres mono en capitales, blocs du fil, couleurs `feed/*`.
//
// Deux routes la rendent — `/scheduled/[id]` (un run d'automatisation) et
// `/jobs/[id]` (un run ouvert depuis Activity) — avec le MÊME chargeur
// (`getSpaceConversationAction`, qui accepte n'importe quel job). `/code/[id]`
// viendra s'y poser à son tour dans une autre PR.
//
// Deux blocs sont SORTIS de la chronologie et remontés en haut : la réponse
// textuelle du run et son récapitulatif de livraison. Ils étaient enfouis dans
// un fil d'appels d'outil replié (Quentin, 18/09 : « la réponse textuelle de
// l'agent est invisible ») ; ce sont pourtant les deux seules choses qu'on vient
// lire quand le run est fini.

import type { SpaceConversationView } from '@/lib/actions.ts';
import StatusPill from '@/components/ui/StatusPill';
import StopRunButton from '@/components/ui/StopRunButton';
import { canStopRun } from '@/lib/job-live.ts';
import Markdown, { plainText } from '@/components/Markdown.tsx';
import StatusBar from '@/app/(dashboard)/spaces/StatusBar.tsx';
import LiveRefresh from '@/app/(dashboard)/spaces/LiveRefresh.tsx';
import DeliveriesCard from '@/app/(dashboard)/spaces/DeliveriesCard.tsx';
import DeliveryBlock from '@/app/(dashboard)/spaces/DeliveryBlock.tsx';
import ConversationFeedView from '@/app/(dashboard)/spaces/ConversationFeedView.tsx';
import VerificationSection from '@/app/(dashboard)/code/[id]/VerificationSection.tsx';
import { threadAgents, threadSubtitle } from '@/app/(dashboard)/spaces/format.ts';
import { truncate } from '@/lib/format-time';
import RunScreen from './RunScreen.tsx';
import RunHeaderCard from './RunHeaderCard.tsx';
import ReviewSection from './ReviewSection.tsx';
import ActivitySection from './ActivitySection.tsx';
import { activityLabel, runView } from './run-view.ts';

export type RunPageProps = {
  data: SpaceConversationView;
};

export default function RunPage({ data }: RunPageProps) {
  const { job, feed, verification, cost } = data;
  const view = runView(data);
  const lastProof = verification.sequences.at(-1) ?? null;
  const agentName = job.agentName ?? '';
  const title = truncate(plainText(job.task), 60);

  return (
    <RunScreen
      avatarName={agentName}
      avatarUrl={job.agentAvatarUrl}
      title={agentName !== '' ? `${agentName} · ${title}` : title}
      subtitle={threadSubtitle('run', job.createdAt)}
      agents={threadAgents(feed.items)}
      status={<StatusPill variant={view.status.variant} label={view.status.label} />}
      proofVerdict={lastProof?.verdict ?? null}
      // ARRÊTER CE RUN, tant qu'il court (#252). La page le décide elle-même :
      // elle a le job et son statut, et deux routes la rendent — leur demander
      // à chacune de passer le bouton en faisait une décision à deux endroits,
      // et `/scheduled/[id]` ne l'avait jamais prise.
      actions={canStopRun(job.status) ? <StopRunButton jobId={job.id} status={job.status} /> : null}
      statusBar={
        <StatusBar
          cost={cost}
          proofVerdict={lastProof?.verdict ?? null}
          proofSequences={verification.sequences.length}
          pendingDeliveries={
            data.deliveries.filter((d) => d.outcome === 'prepared' || d.outcome === 'attempted')
              .length
          }
          live={view.live}
        />
      }
    >
      <RunBody data={data} />
    </RunScreen>
  );
}

/**
 * Le CORPS de la page — l'ordre des blocs, et lui seul. Séparé de l'enveloppe
 * (en-tête de page, barres) pour que cet ordre se prouve en test sans monter un
 * routeur : c'est l'ordre qui est la décision produit, pas la charpente.
 */
export function RunBody({ data }: { data: SpaceConversationView }) {
  const { job, verification } = data;
  const view = runView(data);

  return (
    // LA BOÎTE DE `PageShell`, à l'identique : largeur maximale ET gouttières
    // sur le MÊME élément (`px-5 sm:px-8 lg:px-9 max-w-6xl`), et CENTRÉE
    // (`mx-auto`, 20/09 : toutes les pages le sont, celle-ci restait à gauche).
    // C'est ce qui donne la largeur de contenu de toutes les autres pages :
    // 1152 − 2 × 36 = 1080 px au-delà de `lg`. Les porter séparément — les
    // gouttières sur la zone de défilement, la largeur ici — faisait deux
    // boîtes emboîtées et un contenu de 1152 px, soit 72 px de plus que partout
    // ailleurs (Quentin, deux fois : « plus large que toutes les autres pages »).
    <div
      className="mx-auto w-full max-w-6xl min-w-0 space-y-4 px-5 sm:px-8 lg:px-9"
      data-testid="run-body"
    >
      <LiveRefresh live={view.live} />

      <RunHeaderCard
        runId={job.id}
        task={job.task}
        agentName={job.agentName}
        origin={view.origin}
        model={view.model}
        statusVariant={view.status.variant}
        statusLabel={view.status.label}
        stats={view.stats}
      />

      {/* Pas de liens vers le run parent ni vers les délégués : les délégations
          d'un run se lisent DANS le run, dépliables dans la chronologie, comme
          dans le fil (décision Quentin, 18/09). Une ligne de liens en haut
          renvoyait ailleurs ce qui est déjà là, plus bas. */}

      {/* LA RÉPONSE, hors du fil : ce que le run a répondu, en toutes lettres.
          Absente (un run qui n'a rien dit, ou qui court encore) ⇒ rien. */}
      {view.reply !== null && view.reply.trim() !== '' && (
        <div data-testid="run-reply">
          <Markdown text={view.reply} />
        </div>
      )}

      {/* Ce qui a été LIVRÉ, juste dessous, puis la file d'envoi. Sans le
          lien « Open run » quand il mènerait à CETTE page (Quentin, 22/09 :
          « un bouton Open run qui ouvre le run dans lequel je suis déjà »). */}
      {view.delivered !== null && (
        <DeliveryBlock
          summary={view.delivered.summary}
          jobId={view.delivered.jobId === job.id ? null : view.delivered.jobId}
        />
      )}
      <DeliveriesCard deliveries={data.deliveries} />

      {/* La relecture, avec les VRAIS verdicts du travail et de ses délégués
          (18/09). Le même run les montrait depuis Code et les taisait ici :
          les deux chargeurs lisent maintenant la même chose. Aucun verdict —
          le cas d'une automatisation — et la ligne le dit. */}
      <ReviewSection verdicts={data.verdicts} />

      {/* La preuve — la même section que le détail Code, dessinée au tableau.
          Toujours rendue : elle n'est jamais vide, elle dit ce qui n'a pas
          tourné et pourquoi. */}
      <VerificationSection
        sequences={verification.sequences}
        skippedSurfaces={verification.skippedSurfaces}
        unconfigured={verification.unconfigured}
        stage={job.status ?? 'pending'}
        live={view.live}
      />

      {/* La chronologie, toujours dépliée : c'est ce qu'on vient lire. */}
      <ActivitySection label={activityLabel(view.activity)}>
        <ConversationFeedView
          feed={{ items: view.timeline, totals: data.feed.totals }}
          deliverables={verification.deliverables}
          density="unfolded"
          width="full"
        />
      </ActivitySection>
    </div>
  );
}
