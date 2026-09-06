'use client';

// StatusBar — la barre du bas, permanente (P4, plan « De la maquette au
// produit ») : preuve, modèle, agents, jetons avec part de cache, coût, durée,
// envois en attente. Un clic sur les jetons ou le coût ouvre le panneau « What
// this work cost » : des phrases d'abord, puis le détail par agent et la
// répartition cache lu / cache écrit / frais / sortie, l'attente humaine, le
// temps de preuve. Tout vient de lignes réelles (llm_calls, approval_requests,
// verification_runs, job_deliveries) ; rien n'est deviné — un coût inconnu est
// « n/a », pas 0.

import { useState } from 'react';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import Table, { THead, Th, Tr, Td } from '@/components/ui/Table';
import type { SpaceCostView } from '@/lib/actions.ts';
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

  return (
    <>
      {open && <CostPanel cost={cost} onClose={() => setOpen(false)} />}
      <div className="sticky bottom-0 z-10 -mx-8 mt-8 flex h-7 items-center gap-1 border-t border-rule-2 bg-sidebar px-5 text-mono-11 text-ink-3">
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
        <Seg>
          {cost.byAgent.length} {cost.byAgent.length === 1 ? 'agent' : 'agents'}
        </Seg>
        {live && <Seg>running…</Seg>}
        <span className="ml-auto flex items-center">
          <Seg onClick={() => setOpen((v) => !v)} active={open}>
            {formatTokens(tokens)} tokens{cacheShare !== null ? ` · ${cacheShare} cached` : ''}
          </Seg>
          <Seg onClick={() => setOpen((v) => !v)} active={open} strong>
            {formatCost(t.costUsd)}
            {t.unpricedCalls > 0 ? ' · partial' : ''}
          </Seg>
          <Seg>{formatMs(t.durationMs)}</Seg>
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
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  strong?: boolean;
}) {
  const cls = `inline-flex h-5 items-center gap-1.5 rounded-[6px] px-2.5 ${
    active ? 'bg-ink text-canvas' : strong ? 'text-ink' : ''
  } ${onClick ? 'cursor-pointer hover:bg-hover' : ''}`;
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls} aria-pressed={active}>
        {children}
      </button>
    );
  }
  return <span className={cls}>{children}</span>;
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
  return out;
}

function CostPanel({ cost, onClose }: { cost: SpaceCostView; onClose: () => void }) {
  const t = cost.totals;
  const fresh = Math.max(0, t.inputTokens - t.cachedTokens - t.cacheCreationTokens);
  return (
    <div className="mx-auto mt-8 max-w-[840px]">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-medium-15 text-ink">What this work cost</h2>
        <span className="text-mono-11 text-ink-4">updated every turn · nothing is final</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-[8px] border border-rule-2 bg-paper px-2.5 py-1 text-body-12 text-ink-2 hover:bg-hover"
        >
          Back to the conversation
        </button>
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
