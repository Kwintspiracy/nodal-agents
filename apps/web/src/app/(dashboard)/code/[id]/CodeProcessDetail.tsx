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
//   - la SONDE. Le détail est relu toutes les quatre secondes tant que l'étape
//     est vivante — un process de code court pendant des minutes, et sa page
//     est un tableau de bord qu'on regarde.
//   - les APPROBATIONS en attente, chargées à la même cadence : ce sont les
//     seules choses qui BLOQUENT le process, elles passent donc avant tout.
//
// L'activité est dessinée avec les blocs du fil (`ToolBlock`, `ModelCallBlock`)
// après traduction dans `code-run-view.ts` : un appel d'outil se lit pareil
// qu'on l'ouvre depuis un run d'agent ou depuis un run de code.

import { useEffect, useRef, useState } from 'react';
import {
  getCodingProcessDetailAction,
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

const POLL_INTERVAL = 4000;

export default function CodeProcessDetail({
  query,
  initialDetail,
}: {
  query: { jobId: string } | { sessionId: string };
  initialDetail: CodingProcessDetailData;
}) {
  const [detail, setDetail] = useState(initialDetail);
  // Synced in an effect, never during render (react-hooks/refs).
  const stageRef = useRef(detail.header.stage);
  useEffect(() => {
    stageRef.current = detail.header.stage;
  }, [detail.header.stage]);

  // Approbations en attente appartenant à CE pipeline. Chargées avec la même
  // cadence que le détail ; résolues → le prochain tick les efface.
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRow[]>([]);
  const pipelineIdsRef = useRef(detail.pipelineJobIds);
  useEffect(() => {
    pipelineIdsRef.current = detail.pipelineJobIds;
  }, [detail.pipelineJobIds]);

  // true tant que le process est vivant ; passe à false au premier effet qui
  // le voit terminé — c'est la transition que le dernier tick guette.
  const wasLiveRef = useRef(codeIsLive(initialDetail.header.stage));

  useEffect(() => {
    if (!codeIsLive(stageRef.current)) {
      // Le process n'est plus vivant : purger les cartes d'approbation, sinon
      // elles restent affichées — boutons compris — sur un process terminé
      // (revue P1 du 25/08).
      setPendingApprovals([]);
      if (!wasLiveRef.current) return;
      wasLiveRef.current = false;
      // DERNIER TICK. La preuve tourne à la finalisation — au moment exact où
      // l'étape cesse d'être vivante et où ce poller s'arrête. Un tick de plus
      // après la sortie des étapes vivantes ramène ce que la finalisation a
      // écrit juste après le statut (T24) ; sans lui la section Verification
      // reste vide jusqu'à un rechargement manuel.
      let lastCancelled = false;
      const last = setTimeout(() => {
        void getCodingProcessDetailAction(query).then((result) => {
          if (result.ok && !lastCancelled) setDetail(result.data);
        });
      }, POLL_INTERVAL);
      return () => {
        lastCancelled = true;
        clearTimeout(last);
      };
    }
    wasLiveRef.current = true;
    let cancelled = false;
    const tick = () => {
      if (!codeIsLive(stageRef.current)) return;
      void getCodingProcessDetailAction(query).then((result) => {
        if (result.ok && !cancelled) setDetail(result.data);
      });
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
    // Premier chargement des approbations sans attendre 4s — un process déjà
    // bloqué au moment où la page s'ouvre doit montrer sa carte tout de suite.
    const first = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      clearInterval(id);
      clearTimeout(first);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.header.stage]);

  const { header, activity, verdicts, changes } = detail;
  const status = codeStatus(header.stage);
  const delivered = codeDelivery(detail);
  const live = codeIsLive(header.stage);

  return (
    // La largeur du corps de toute page Nodal, calée à gauche, et 16 px entre
    // les cartes — la même règle que la page d'un run d'agent.
    <div className="max-w-6xl min-w-0 space-y-4" data-testid="run-body">
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
      {pendingApprovals.map((a) => (
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
