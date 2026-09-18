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

import type { ReactNode } from 'react';
import type { SpaceConversationView } from '@/lib/actions.ts';
import type { BackLink } from '@/lib/back-links.ts';
import PageShell from '@/components/ui/PageShell';
import StatusPill from '@/components/ui/StatusPill';
import Markdown, { plainText } from '@/components/Markdown.tsx';
import ThreadHeader from '@/app/(dashboard)/chat/[id]/ThreadHeader.tsx';
import ThreadScreen from '@/app/(dashboard)/chat/[id]/ThreadScreen.tsx';
import WorkBar from '@/app/(dashboard)/spaces/WorkBar.tsx';
import StatusBar from '@/app/(dashboard)/spaces/StatusBar.tsx';
import LiveRefresh from '@/app/(dashboard)/spaces/LiveRefresh.tsx';
import DeliveriesCard from '@/app/(dashboard)/spaces/DeliveriesCard.tsx';
import DeliveryBlock from '@/app/(dashboard)/spaces/DeliveryBlock.tsx';
import ConversationFeedView from '@/app/(dashboard)/spaces/ConversationFeedView.tsx';
import VerificationSection from '@/app/(dashboard)/code/[id]/VerificationSection.tsx';
import { threadAgents, threadSubtitle } from '@/app/(dashboard)/spaces/format.ts';
import { truncate } from '@/lib/format-time';
import RunHeaderCard from './RunHeaderCard.tsx';
import ReviewSection from './ReviewSection.tsx';
import ActivitySection from './ActivitySection.tsx';
import { activityLabel, runView } from './run-view.ts';

export type RunPageProps = {
  data: SpaceConversationView;
  /** D'où l'on vient, calculé par `runBackLink` sur la donnée du job. */
  back: BackLink;
  /** Ce que la route ajoute dans la carte de tête (annuler un run vivant). */
  actions?: ReactNode;
};

export default function RunPage({ data, back, actions = null }: RunPageProps) {
  const { job, feed, verification, cost } = data;
  const view = runView(data);
  const lastProof = verification.sequences.at(-1) ?? null;
  const agentName = job.agentName ?? '';
  const title = truncate(plainText(job.task), 60);

  return (
    <PageShell
      fill
      toolbarBleed
      header={
        <ThreadHeader
          avatarName={agentName}
          avatarUrl={job.agentAvatarUrl}
          title={agentName !== '' ? `${agentName} · ${title}` : title}
          subtitle={threadSubtitle('run', job.createdAt)}
        />
      }
      toolbar={
        <WorkBar
          back={back}
          agents={threadAgents(feed.items)}
          status={<StatusPill variant={view.status.variant} label={view.status.label} />}
          proofVerdict={lastProof?.verdict ?? null}
        />
      }
    >
      <ThreadScreen
        // Un run s'ouvre sur SA CARTE DE TÊTE et ne bouge jamais tout seul.
        // L'écran d'un fil saute en bas à l'ouverture et suit ce qui arrive,
        // parce qu'une conversation se lit par sa fin ; la page d'un run est un
        // tableau, et elle s'ouvrait donc déjà défilée (Quentin, 18/09). Un run
        // qui court ne doit pas non plus faire filer ce qu'on est en train de
        // lire à chaque rafraîchissement.
        follow="never"
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
        <RunBody data={data} actions={actions} />
      </ThreadScreen>
    </PageShell>
  );
}

/**
 * Le CORPS de la page — l'ordre des blocs, et lui seul. Séparé de l'enveloppe
 * (en-tête de page, barres) pour que cet ordre se prouve en test sans monter un
 * routeur : c'est l'ordre qui est la décision produit, pas la charpente.
 */
export function RunBody({
  data,
  actions = null,
}: {
  data: SpaceConversationView;
  actions?: ReactNode;
}) {
  const { job, verification } = data;
  const view = runView(data);

  return (
    // La largeur du corps de TOUTE page Nodal : `max-w-6xl`, calée à gauche,
    // dans les gouttières que `ThreadScroller` porte déjà. Le tableau dessine
    // un corps de 1140 px à 28 px des bords — c'est exactement cette règle sur
    // un écran de 1440. Pleine largeur, les cartes s'étiraient d'un bord à
    // l'autre et la page ne ressemblait plus à aucune autre (Quentin, vu sur
    // la stack).
    <div className="max-w-6xl min-w-0 space-y-4" data-testid="run-body">
      <LiveRefresh live={view.live} />

      <RunHeaderCard
        task={job.task}
        agentName={job.agentName}
        origin={view.origin}
        model={view.model}
        statusVariant={view.status.variant}
        statusLabel={view.status.label}
        stats={view.stats}
        actions={actions}
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

      {/* Ce qui a été LIVRÉ, juste dessous, puis la file d'envoi. */}
      {view.delivered !== null && (
        <DeliveryBlock summary={view.delivered.summary} jobId={view.delivered.jobId} />
      )}
      <DeliveriesCard deliveries={data.deliveries} />

      {/* La relecture. Vide sur un run d'automatisation : la ligne le dit. */}
      <ReviewSection verdicts={[]} />

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
