'use client';

// StatusBar — la barre du bas, permanente (P4, plan « De la maquette au
// produit ») : preuve, modèle, agents, jetons avec part de cache, coût, durée,
// envois en attente. Un clic sur les jetons ou le coût ouvre le panneau « What
// this work cost » : des phrases d'abord, puis le détail par agent et la
// répartition cache lu / cache écrit / frais / sortie, l'attente humaine, le
// temps de preuve. Tout vient de lignes réelles (llm_calls, approval_requests,
// verification_runs, job_deliveries) ; rien n'est deviné — un coût inconnu est
// « n/a », pas 0.
//
// #54 — à côté du coût, ce que les REPRISES après délégation ont coûté en
// cache expiré, quand il y en a. La règle vit dans `lib/cache-expiry.ts` ; la
// barre ne fait que la dire. Rien ne s'affiche quand la somme est nulle ou
// inconnue : « $0.0000 lost » ferait croire qu'on a mesuré zéro.

import { useState } from 'react';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import Table, { THead, Th, Tr, Td } from '@/components/ui/Table';
import TextButton from '@/components/ui/TextButton';
import RowActionButton from '@/components/ui/RowActionButton';
import type { SpaceCostView } from '@/lib/space-cost.ts';
import { formatCost, formatMs, formatTokens } from './format.ts';

export type StatusBarProps = {
  cost: SpaceCostView;
  /** Le verdict de la dernière séquence de preuve : 'green' | 'red' | 'infra_error' | null (aucune). */
  proofVerdict: string | null;
  proofSequences: number;
  pendingDeliveries: number;
  live: boolean;
};

function pct(part: number, total: number): string {
  if (total <= 0) return '0 %';
  return `${Math.round((part / total) * 100)} %`;
}

/**
 * #54 — « of which $0.16 lost to cache expiry (2 resumes) », ou `null` quand
 * il n'y a rien à dire : aucune reprise, ou aucune reprise sur un modèle dont
 * le catalogue connaît le prix de cache. Un `$0.0000` afficherait « on a
 * mesuré, c'est nul » là où la vérité est « on ne sait pas » (invariant #4) ;
 * le panneau détaillé, lui, dit les jetons dans les deux cas.
 *
 * Quand une PARTIE seulement des reprises est tarifée, le montant est vrai mais
 * INCOMPLET, et il le dit avec le mot du segment voisin : « · partial », que la
 * ligne de coût pose déjà pour `unpricedCalls`. Deux sommes partielles côte à
 * côte doivent porter le même mot, sinon celle qui se tait passe pour entière
 * (revue Reviewer C, passe 1).
 */
export function cacheLostLabel(cost: SpaceCostView): string | null {
  const { resumes, costUsd, unpricedResumes } = cost.cacheLost;
  if (resumes === 0 || costUsd === null || costUsd <= 0) return null;
  const partial = unpricedResumes > 0 ? ' · partial' : '';
  return `of which ${formatCost(costUsd)} lost to cache expiry (${resumes} ${
    resumes === 1 ? 'resume' : 'resumes'
  })${partial}`;
}

export default function StatusBar({
  cost,
  proofVerdict,
  proofSequences,
  pendingDeliveries,
  live,
}: StatusBarProps) {
  const [open, setOpen] = useState(false);
  const t = cost.totals;
  const tokens = t.inputTokens + t.outputTokens;
  const cacheShare = t.inputTokens > 0 ? pct(t.cachedTokens, t.inputTokens) : null;
  const models = cost.byAgent.flatMap((a) => a.models);
  const modelLabel = [...new Set(models)].join(', ');
  const lostLabel = cacheLostLabel(cost);

  return (
    <>
      {open && <CostPanel cost={cost} onClose={() => setOpen(false)} />}
      {/* Ancrée en bas de l'écran et PLEINE LARGEUR, comme l'en-tête en haut :
          elle s'arrêtait à la largeur du contenu et flottait au milieu quand le
          fil était court (Quentin, 07/09). */}
      <div className="flex h-7 shrink-0 items-center gap-1 border-t border-rule-2 bg-sidebar px-5 text-mono-11 text-ink-3">
        <Seg>
          {proofSequences === 0 ? (
            <span>no proof</span>
          ) : proofVerdict === 'green' ? (
            <>
              <span className="text-ok">✓</span> proof green
            </>
          ) : proofVerdict === 'red' ? (
            <>
              <span className="text-warn">✕</span> proof red
            </>
          ) : (
            <>
              <span className="text-warn">!</span> proof {proofVerdict}
            </>
          )}
        </Seg>
        {modelLabel !== '' && <Seg>{modelLabel}</Seg>}
        {/* Le compte d'agents n'est PLUS ici : l'en-tête le dit déjà, avec les
            visages, et les deux ne comptaient pas la même chose — « 1 agent »
            en haut, « 0 agents » en bas sous la même réponse (Quentin, 07/09).
            Un seul endroit le dit, celui qui a les visages. */}
        {live && <Seg>running…</Seg>}
        <span className="ml-auto flex items-center">
          {/* AUCUN appel connu : le fil ne dit pas « 0 tokens · n/a », qui se
              lit « c'était gratuit ». Il arrive qu'on ne sache rien — un fil
              d'avant la migration 0100, ou un agent en runtime CLI, dont la
              consommation vit dans `cli_runs` et n'est pas encore agrégée ici
              (revue Codex, passe 65). Ne rien savoir se dit. */}
          {t.calls === 0 ? (
            <Seg title="No LLM call recorded for this thread">no usage recorded</Seg>
          ) : (
            <>
              <Seg onClick={() => setOpen((v) => !v)} active={open}>
                {formatTokens(tokens)} tokens{cacheShare !== null ? ` · ${cacheShare} cached` : ''}
              </Seg>
              <Seg onClick={() => setOpen((v) => !v)} active={open} strong>
                {formatCost(t.costUsd)}
                {t.unpricedCalls > 0 ? ' · partial' : ''}
              </Seg>
              {lostLabel !== null && (
                <Seg title="Input tokens re-billed at full price because the provider's cache expired while a delegate was working">
                  {lostLabel}
                </Seg>
              )}
            </>
          )}
          {/* Le temps que les modèles ont passé à répondre — pas le temps
              écoulé depuis l'ouverture du fil, qui affichait « 8 min 36 » sous
              une réponse de sept secondes parce que la conversation était
              ouverte depuis huit minutes (Quentin, 07/09). Le temps écoulé
              n'apprend rien : une conversation laissée ouverte ne coûte rien. */}
          {t.calls > 0 && (
            <Seg title="Time the models spent answering">{formatMs(t.llmDurationMs)} thinking</Seg>
          )}
          {pendingDeliveries > 0 && (
            <Seg>
              <span className="text-warn">●</span> {pendingDeliveries}{' '}
              {pendingDeliveries === 1 ? 'delivery pending' : 'deliveries pending'}
            </Seg>
          )}
        </span>
      </div>
    </>
  );
}

function Seg({
  children,
  onClick,
  active = false,
  strong = false,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  strong?: boolean;
  /** Ce que le segment mesure, en toutes lettres, au survol. */
  title?: string;
}) {
  const cls = `inline-flex h-5 items-center gap-1.5 rounded-[6px] px-2.5 ${
    active ? 'bg-ink text-canvas' : strong ? 'text-ink' : ''
  } ${onClick ? 'cursor-pointer hover:bg-hover' : ''}`;
  if (onClick) {
    return (
      <TextButton
        onClick={onClick}
        className={cls}
        aria-expanded={active}
        aria-controls="space-cost-panel"
      >
        {children}
      </TextButton>
    );
  }
  return (
    <span className={cls} {...(title !== undefined ? { title } : {})}>
      {children}
    </span>
  );
}

// ─── Le panneau « What this work cost » ─────────────────────────────────────

function sentences(cost: SpaceCostView): string[] {
  const t = cost.totals;
  const out: string[] = [];
  const total = t.inputTokens + t.outputTokens;
  if (total === 0) return ['No model call recorded for this work yet.'];
  if (t.cachedTokens > 0) {
    out.push(
      `Of the ${formatTokens(total)} tokens this work used, ${pct(t.cachedTokens, t.inputTokens)} of the input was read back from the provider's cache, billed at the cached rate.`,
    );
  } else {
    out.push(`This work used ${formatTokens(total)} tokens; none came back from a cache.`);
  }
  if (t.costUsd !== null) {
    out.push(
      `It cost ${formatCost(t.costUsd)}${t.unpricedCalls > 0 ? `, not counting ${t.unpricedCalls} ${t.unpricedCalls === 1 ? 'call' : 'calls'} on a model with no known price` : ''}.`,
    );
  } else {
    out.push('Its cost is unknown: no call was on a model with a known price.');
  }
  if (t.humanWaitMs > 0) {
    out.push(
      `${formatMs(t.humanWaitMs)} of it was spent waiting for you to approve something, not working.`,
    );
  }
  if (t.proofMs > 0) {
    out.push(`${formatMs(t.proofMs)} went to running the proof.`);
  }
  // #54 — la phrase nomme la CAUSE, pas seulement le montant : le parent
  // repaie son contexte parce que la délégation a duré plus longtemps que le
  // cache du fournisseur.
  const lost = cost.cacheLost;
  if (lost.resumes > 0) {
    const what =
      lost.costUsd !== null && lost.costUsd > 0
        ? `${formatTokens(lost.tokens)} input tokens, ${formatCost(lost.costUsd)}`
        : `${formatTokens(lost.tokens)} input tokens`;
    out.push(
      `${what} went back to full price on ${lost.resumes} ${lost.resumes === 1 ? 'resume' : 'resumes'}: the provider's cache expired while a delegate was working.${
        lost.unpricedResumes > 0
          ? ` ${lost.unpricedResumes} of them ran on a model whose cache price we do not know, so the amount is partial.`
          : ''
      }`,
    );
  }
  return out;
}

/**
 * Exporté pour être RENDU SEUL par le test d'écran : le panneau ne s'ouvre
 * que sur un clic, et `apps/web` n'a pas de bibliothèque de rendu
 * interactif — sans cet export, sa copie ne serait prouvée nulle part.
 */
export function CostPanel({ cost, onClose }: { cost: SpaceCostView; onClose: () => void }) {
  const t = cost.totals;
  const fresh = Math.max(0, t.inputTokens - t.cachedTokens - t.cacheCreationTokens);
  const lost = cost.cacheLost;
  return (
    <div id="space-cost-panel" className="mx-auto mt-8 max-w-[840px]">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-medium-15 text-ink">What this work cost</h2>
        <span className="text-mono-11 text-ink-4">updated every turn · nothing is final</span>
        {/* Une action secondaire, dessinée comme un bouton : le contrôle de
            ligne libellé du DS, pas un lien texte (revue passe 26). */}
        <RowActionButton onClick={onClose} className="ml-auto">
          Back to the conversation
        </RowActionButton>
      </div>
      {sentences(cost).map((s, i) => (
        <p key={i} className="mb-3 max-w-[66ch] text-body-14 text-ink-2">
          {s}
        </p>
      ))}
      <div className="mt-4 overflow-hidden rounded-xl border border-rule-2 bg-paper">
        <Table frame={false}>
          <THead>
            <Th>Agent</Th>
            <Th>Model</Th>
            <Th align="right">Calls</Th>
            <Th align="right">Tokens</Th>
            <Th align="right">Cached</Th>
            <Th align="right">Cost</Th>
          </THead>
          <tbody>
            {cost.byAgent.map((a) => (
              <Tr key={a.agentId ?? a.agentName}>
                <Td className="text-body-13 text-ink">{a.agentName}</Td>
                <Td className="text-mono-11 text-ink-3">{a.models.join(', ')}</Td>
                <Td align="right" className="text-mono-12 text-ink-2">
                  {a.calls}
                </Td>
                <Td align="right" className="text-mono-12 text-ink-2">
                  {formatTokens(a.inputTokens + a.outputTokens)}
                </Td>
                <Td align="right" className="text-mono-12 text-ink-2">
                  {pct(a.cachedTokens, a.inputTokens)}
                </Td>
                <Td align="right" className="text-mono-12 text-ink-2">
                  {formatCost(a.costUsd)}
                  {a.unpricedCalls > 0 && (
                    <>
                      {' '}
                      <MonoMicroTag tone="warn">partial</MonoMicroTag>
                    </>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
      <dl className="mt-4 grid grid-cols-[190px_1fr] gap-x-4 gap-y-1.5 rounded-xl border border-rule-2 bg-paper px-4 py-3 text-mono-11">
        <dt className="text-ink-4">cache read</dt>
        <dd className="text-ok">
          {formatTokens(t.cachedTokens)} · {pct(t.cachedTokens, t.inputTokens)} of input
        </dd>
        <dt className="text-ink-4">cache written</dt>
        <dd className="text-ink-2">
          {formatTokens(t.cacheCreationTokens)} · {pct(t.cacheCreationTokens, t.inputTokens)}
        </dd>
        {/* #54 — la ligne n'apparaît que s'il y a eu une reprise : une ligne
            « 0 » permanente ferait du bruit sur tous les runs sans délégation. */}
        {lost.resumes > 0 && (
          <>
            <dt className="text-ink-4">cache lost on resume</dt>
            <dd className="text-warn">
              {formatTokens(lost.tokens)} · {formatCost(lost.costUsd)} · {lost.resumes}{' '}
              {lost.resumes === 1 ? 'resume' : 'resumes'}
            </dd>
          </>
        )}
        <dt className="text-ink-4">fresh input</dt>
        <dd className="text-ink-2">
          {formatTokens(fresh)} · {pct(fresh, t.inputTokens)}
        </dd>
        <dt className="text-ink-4">output</dt>
        <dd className="text-ink-2">{formatTokens(t.outputTokens)}</dd>
        <dt className="text-ink-4">waiting on you</dt>
        <dd className="text-ink-2">
          {t.humanWaitMs > 0 ? `${formatMs(t.humanWaitMs)} of ${formatMs(t.durationMs)}` : 'none'}
        </dd>
        <dt className="text-ink-4">proof time</dt>
        <dd className="text-ink-2">{t.proofMs > 0 ? formatMs(t.proofMs) : 'no proof ran'}</dd>
      </dl>
    </div>
  );
}
