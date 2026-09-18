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
import ApprovalActions from '@/app/(dashboard)/approvals/ApprovalActions.tsx';
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

  const { header, activity, verdicts, changes } = detail;
  const status = codeStatus(header.stage);
  const delivered = codeDelivery(detail);
  // Un process TERMINÉ ne montre aucune carte d'approbation — boutons compris
  // (revue P1 du 25/08). C'est une lecture, pas un effet : vider l'état dans un
  // effet déclenchait un rendu en cascade, et le résultat à l'écran est le même.
  const approvals = live ? pendingApprovals : [];

  return (
    // LA BOÎTE DE `PageShell`, à l'identique — largeur maximale ET gouttières
    // sur le même élément, comme le corps d'un run d'agent : c'est ce qui donne
    // la largeur de contenu de toutes les autres pages.
    <div className="max-w-6xl min-w-0 space-y-4 px-5 sm:px-8 lg:px-9" data-testid="run-body">
      {refresh && <LiveRefresh live={live} everyMs={POLL_INTERVAL} />}

      <RunHeaderCard
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
        <div
          key={a.id}
          className="space-y-3 overflow-hidden rounded-xl border border-warn/40 border-l-4 border-l-warn bg-paper p-4"
          data-testid="approval-card"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-medium-14 text-ink">{a.explanation.what}</span>
            <MonoMicroTag tone="ink">{a.agentName ?? 'agent'}</MonoMicroTag>
            <span className="text-mono-11 text-ink-4">{a.toolName}</span>
          </div>
          <div className="space-y-1.5 rounded-md border border-rule-2 bg-canvas px-3 py-2">
            <p className="text-body-13 italic text-ink-2">
              {a.explanation.purpose
                ? `« ${a.explanation.purpose} »`
                : "L'agent n'a pas expliqué pourquoi."}
            </p>
            <p className="text-body-12 text-warn">
              {a.explanation.effectLabel}
              {a.explanation.target && (
                <span className="text-ink-2"> → {a.explanation.target}</span>
              )}
            </p>
            {a.explanation.args.length > 0 && (
              <dl className="space-y-0.5 pt-0.5">
                {a.explanation.args.map((arg) => (
                  <div key={arg.key} className="flex gap-2 text-mono-12">
                    <dt className="shrink-0 text-ink-3">{arg.key}</dt>
                    <dd className="min-w-0 break-all text-ink-2">
                      {arg.value}
                      {arg.truncated && (
                        <span className="text-ink-3">
                          {' '}
                          ({arg.fullLength} caractères, 300 affichés)
                        </span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <ApprovalActions
            approvalId={a.id}
            toolName={a.toolName}
            agentId={a.agentId}
            mcpRulePattern={a.mcpRulePattern}
            mcpServerName={a.explanation.provenance.name ?? null}
          />
        </div>
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
