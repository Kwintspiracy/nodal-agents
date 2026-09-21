'use client';

// CodeProcessDetail — LE CORPS de la page d'un process de code.
//
// 18/09 — cette page dessinait son propre écran : un en-tête à elle, des
// verdicts à elle, une activité en lignes à elle. C'est un RUN, comme celui
// d'une automatisation ou d'une délégation, et il se lit maintenant dans les
// mêmes blocs, dans le même ordre (planche #135) : la carte de tête et ses sept
// chiffres, ce qui a été livré, ce qui a été relu, ce qui a été prouvé, les
// fichiers, et l'activité. La charpente (les deux barres, le défilement) vit
// dans `RunScreen`, montée par la route ; ici ne reste que le corps et ce qui le
// tient VIVANT.
//
// Ce qui reste propre à cette page, et pourquoi :
//   - la FRAÎCHEUR. Un process de code court pendant des minutes et sa page est
//     un tableau de bord qu'on regarde : elle se relit toutes les quatre
//     secondes tant que l'étape est vivante. Depuis le 18/09 c'est
//     `LiveRefresh` — le SERVEUR rend à nouveau, donc les barres du haut
//     suivent l'état, alors qu'une sonde côté client ne rafraîchissait que ce
//     corps et laissait la barre sur l'état du chargement.
//   - les APPROBATIONS en attente, relues à la même cadence côté client : ce
//     sont les seules choses qui BLOQUENT le process, et elles doivent
//     apparaître sans attendre le rendu suivant.
//
// L'activité est dessinée avec les blocs du fil (`ToolBlock`, `ModelCallBlock`)
// après traduction dans `code-run-view.ts` : un appel d'outil se lit pareil
// qu'on l'ouvre depuis un run d'agent ou depuis un run de code.

import { useEffect, useRef, useState } from 'react';
import {
  listApprovalsAction,
  type ApprovalRow,
  type CodingProcessDetail as CodingProcessDetailData,
  type CodingActivityItem,
} from '@/lib/actions.ts';
import { labelDuConstat } from '@/lib/constated-files.ts';
import ApprovalRequestCard from '@/app/(dashboard)/approvals/ApprovalRequestCard.tsx';
import VerificationSection from './VerificationSection.tsx';
import FileChangeBlock from './FileChangeBlock.tsx';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import ToolBlock from '@/app/(dashboard)/spaces/ToolBlock.tsx';
import ModelCallBlock from '@/app/(dashboard)/spaces/ModelCallBlock.tsx';
import DeliveryBlock from '@/app/(dashboard)/spaces/DeliveryBlock.tsx';
import LiveRefresh from '@/app/(dashboard)/spaces/LiveRefresh.tsx';
import RunHeaderCard from '@/app/(dashboard)/runs/RunHeaderCard.tsx';
import ReviewSection from '@/app/(dashboard)/runs/ReviewSection.tsx';
import ActivitySection from '@/app/(dashboard)/runs/ActivitySection.tsx';
import {
  codeActivityLabel,
  codeDelivery,
  codeIsLive,
  codeOrigin,
  codeRuntime,
  codeStats,
  codeStatus,
  toolStepOfCall,
  turnModelLines,
} from './code-run-view.ts';

/** La cadence d'un process vivant : les approbations, et la relecture de la page. */
export const POLL_INTERVAL = 4000;

export default function CodeProcessDetail({
  detail,
  refresh = true,
}: {
  detail: CodingProcessDetailData;
  /**
   * true (défaut) : la page se relit toute seule tant que le process court —
   * `LiveRefresh`, comme les deux autres pages de run. C'est le SERVEUR qui
   * rend à nouveau, donc les barres du haut suivent l'état au lieu de figer
   * celui du chargement (Quentin, 18/09 : la barre de /code n'était pas celle
   * de la maquette, faute d'une pastille qu'on n'osait pas y mettre).
   *
   * false : l'appelant tient lui-même la fraîcheur de sa donnée — c'est le cas
   * du poste de travail projet, qui charge le détail côté client.
   */
  refresh?: boolean;
}) {
  const live = codeIsLive(detail.header.stage);

  // Approbations en attente appartenant à CE pipeline, relues à la même
  // cadence ; résolues → le prochain tick les efface. Elles restent côté
  // client : ce sont les seules choses qui bloquent, et elles doivent
  // apparaître sans attendre le rendu suivant du serveur.
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRow[]>([]);
  const pipelineIds = detail.pipelineJobIds;
  const pipelineIdsRef = useRef(pipelineIds);
  useEffect(() => {
    pipelineIdsRef.current = pipelineIds;
  }, [pipelineIds]);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const tick = () => {
      // Filtré en SQL sur les jobs de CE pipeline : le navigateur ne reçoit
      // plus les approbations des autres jobs, et une approbation ancienne ne
      // peut plus tomber hors de la fenêtre des 100 plus récentes.
      void listApprovalsAction({ status: 'pending', jobIds: pipelineIdsRef.current }).then(
        (result) => {
          if (!result.ok || cancelled) return;
          setPendingApprovals(result.data);
        },
      );
    };
    const id = setInterval(tick, POLL_INTERVAL);
    // Premier chargement sans attendre 4 s — un process déjà bloqué au moment
    // où la page s'ouvre doit montrer sa carte tout de suite.
    const first = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      clearInterval(id);
      clearTimeout(first);
    };
  }, [live]);

  const { header, activity, verdicts, changes, constatedBy } = detail;
  const status = codeStatus(header.stage);
  const delivered = codeDelivery(detail);
  // Un process TERMINÉ ne montre aucune carte d'approbation — boutons compris
  // (revue P1 du 25/08). C'est une lecture, pas un effet : vider l'état dans un
  // effet déclenchait un rendu en cascade, et le résultat à l'écran est le même.
  const approvals = live ? pendingApprovals : [];

  return (
    // LA BOÎTE DE `PageShell`, à l'identique — largeur maximale ET gouttières
    // sur le même élément, centrée (`mx-auto`, 20/09), comme le corps d'un run
    // d'agent : c'est ce qui donne
    // la largeur de contenu de toutes les autres pages.
    <div
      className="mx-auto w-full max-w-6xl min-w-0 space-y-4 px-5 sm:px-8 lg:px-9"
      data-testid="run-body"
    >
      {refresh && <LiveRefresh live={live} everyMs={POLL_INTERVAL} />}

      <RunHeaderCard
        runId={header.id}
        task={header.task}
        agentName={header.agentName}
        origin={codeOrigin(header)}
        model={codeRuntime(header, activity)}
        statusVariant={status.variant}
        statusLabel={status.label}
        stats={codeStats(header)}
      />

      {/* La RÉPONSE d'un process de code n'existe pas dans cette donnée : le
          détail ne porte ni `result` ni texte final. Rien n'est donc dessiné à
          la place — ce que le run a fait se lit dans les blocs ci-dessous. */}

      {delivered !== null && <DeliveryBlock summary={delivered} jobId={null} />}

      {/* Les approbations en attente du pipeline : la seule chose qui BLOQUE le
          process, donc au-dessus des sections qui racontent ce qui est fait. */}
      {approvals.map((a) => (
        <ApprovalRequestCard key={a.id} approval={a} />
      ))}

      {/* La relecture, avec les VRAIS verdicts — c'est pour eux que la section
          a été typée sur `CodingVerdictView` quand elle est née côté runs. */}
      <ReviewSection verdicts={verdicts} reviewing={header.stage === 'review'} />

      {/* La preuve — la même section, le même dessin, pour les trois routes. */}
      <VerificationSection
        sequences={detail.verificationRuns}
        skippedSurfaces={detail.verificationSkippedSurfaces}
        unconfigured={detail.verificationUnconfigured}
        stage={header.stage}
        live={live}
      />

      <div className="overflow-hidden rounded-xl border border-rule-2 bg-paper">
        <h2 className="border-b border-rule-2 px-4 py-3 text-mono-11 tracking-wider text-ink-4 uppercase">
          Files{changes.length > 0 ? ` · ${changes.length}` : ''}
        </h2>
        {changes.length === 0 ? (
          <p className="px-4 py-6 text-body-13 text-ink-4">No files changed yet.</p>
        ) : (
          <div className="space-y-3 p-4">
            {changes.map((group) => (
              <FileChangeBlock key={group.filePath} group={group} />
            ))}
          </div>
        )}
        {/* CE QUI FAIT FOI POUR CETTE LISTE (issue #199), en une ligne.
            Une liste prise dans `git status` avant et après chaque run ne
            promet pas la même chose qu'une liste des fichiers que les outils
            ont nommés, et une liste simplement déclarée ne promet rien du
            tout. Les confondre en silence serait le faux vert que #102 a
            retiré, revenu à l'écran (invariant #4). */}
        <p
          className="border-t border-rule-2 px-4 py-2 text-body-12 text-ink-4"
          data-testid="files-constat"
        >
          {labelDuConstat(constatedBy)}
        </p>
      </div>

      {/* L'activité, toujours ouverte : c'est ce qu'on vient lire. Pas de
          filtre par agent (Quentin a retiré la rangée de pastilles le 18/09) —
          chaque bloc dit déjà qui l'a exécuté. */}
      <ActivitySection label={codeActivityLabel(header, activity)}>
        {activity.length === 0 ? (
          <p className="py-4 text-body-13 text-ink-4">
            {header.kind === 'chat'
              ? "Chat sessions don't record a tool-call trail yet, only their run history."
              : 'No activity recorded yet.'}
          </p>
        ) : (
          <div className="space-y-2 py-2">
            {activity.map((item, i) => (
              <ActivityBlock key={item.kind === 'call' ? item.id : `turn-${i}`} item={item} />
            ))}
          </div>
        )}
      </ActivitySection>
    </div>
  );
}

/**
 * Un pas de l'activité, dessiné comme le fil le dessine : un appel d'outil est
 * un `ToolBlock` (ligne repliée, plaques Input/Result dépliées), un marqueur de
 * tour est un `ModelCallBlock`. Rien n'est redessiné ici — seule la traduction
 * vit dans `code-run-view.ts`.
 */
function ActivityBlock({ item }: { item: CodingActivityItem }) {
  if (item.kind === 'turn') {
    return (
      <>
        {turnModelLines(item).map((line, i) => (
          <ModelCallBlock key={i} model={line.model} usage={line.usage} />
        ))}
      </>
    );
  }
  const delegate = item.delegatedFrom?.agentName ?? null;
  return (
    <ToolBlock
      step={toolStepOfCall(item, item.delegatedFrom?.jobId ?? '')}
      {...(delegate !== null
        ? { tag: <MonoMicroTag tone="agent">delegated · {delegate}</MonoMicroTag> }
        : {})}
    />
  );
}
