'use client';

// StepsGroup — les actions mineures d'un tour, repliées : raisonnement,
// lectures, recherches, accusés, brut. Le titre se déduit des CARTES du
// groupe, jamais des noms d'outils ; déplié, chaque étape montre son outil,
// sa carte, sa durée, et ce que l'écran a le droit de dire de son résultat.

import { useState } from 'react';
import DisclosureButton from '@/components/ui/DisclosureButton';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import type { Step } from '@/lib/conversation-feed.ts';
import { formatMs, shortToolName, summarizeSteps } from './format.ts';

export default function StepsGroup({ steps }: { steps: Step[] }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeSteps(steps);
  const totalMs = steps.reduce(
    (acc, s) => acc + (s.kind === 'tool' && s.durationMs !== null ? s.durationMs : 0),
    0,
  );

  return (
    <div className="max-w-[720px] overflow-hidden rounded-[10px] border border-rule-2 bg-paper">
      <DisclosureButton open={open} onClick={() => setOpen((v) => !v)} className="py-2">
        <span className="text-medium-13 text-ink-2">{summary}</span>
        <span className="ml-auto text-mono-11 text-ink-4">
          {steps.length} {steps.length === 1 ? 'step' : 'steps'}
          {totalMs > 0 ? ` · ${formatMs(totalMs)}` : ''}
        </span>
      </DisclosureButton>
      {open && (
        <ul className="border-t border-rule-2 py-2">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-3 px-4 py-1.5 text-body-12 text-ink-3">
              {s.kind === 'reasoning' ? (
                <>
                  <span className="w-[158px] shrink-0 text-mono-11 text-ink-2">reasoning</span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words italic">
                    {s.text}
                  </span>
                </>
              ) : (
                <>
                  <span
                    className="w-[158px] shrink-0 truncate text-mono-11 text-ink-2"
                    title={s.toolName}
                  >
                    {shortToolName(s.toolName)}
                  </span>
                  <span className="min-w-0 flex-1 break-words">
                    <StepLine step={s} />
                  </span>
                  <span className="shrink-0 text-mono-11 text-ink-4">
                    {s.durationMs !== null ? formatMs(s.durationMs) : ''}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Ce qu'une étape repliée dit de son résultat : depuis la charge utile, sinon le brut. */
function StepLine({ step }: { step: Extract<Step, { kind: 'tool' }> }) {
  if (step.outcome === 'error' || step.outcome === 'blocked') {
    return (
      <span className="text-err">
        {step.outcome} <RawExcerpt text={step.outputText} />
      </span>
    );
  }
  if (step.outcome === 'awaiting_approval') {
    return <MonoMicroTag tone="warn">awaiting approval</MonoMicroTag>;
  }
  const p = step.presented;
  if (p === null) {
    // Pas de charge utile : ce qu'on a de plus vrai, c'est la sortie brute,
    // sinon l'entrée (un `return_result` n'a pas de ligne d'audit : son texte
    // est dans l'appel).
    return (
      <>
        {step.card !== null && <MonoMicroTag tone="ink">{step.card}</MonoMicroTag>}{' '}
        <RawExcerpt text={step.outputText ?? excerptOfInput(step.input)} />
      </>
    );
  }
  switch (p.card) {
    case 'text':
      return (
        <span className={p.failure ? 'text-err' : ''}>
          {p.text}
          {p.truncated ? ' …' : ''}
        </span>
      );
    case 'read':
      return (
        <>
          {p.path ?? 'document'} · {p.chars.toLocaleString('en-US')} chars
          {p.sections !== undefined ? ` · ${p.sections} sections` : ''}
          {p.truncated ? ' · truncated' : ''}
        </>
      );
    case 'search':
      return (
        <>
          “{p.query}” · {p.total} {p.total === 1 ? 'match' : 'matches'}
          {p.hits[0] ? ` · ${p.hits[0].title}` : ''}
          {p.truncated ? ' · truncated' : ''}
        </>
      );
    case 'table':
      return (
        <>
          {p.tables.length} {p.tables.length === 1 ? 'table' : 'tables'} ·{' '}
          {p.tables.reduce((acc, t) => acc + t.total, 0)} rows
        </>
      );
    case 'files':
      return (
        <>
          {p.total} {p.total === 1 ? 'file' : 'files'} · {p.files[0]?.path ?? ''}
        </>
      );
    case 'generic':
      return (
        <>
          <MonoMicroTag tone="ink">raw</MonoMicroTag> <RawExcerpt text={step.outputText} />
        </>
      );
    default:
      return <MonoMicroTag tone="ink">{p.card}</MonoMicroTag>;
  }
}

/** L'entrée d'un appel, en une ligne : la valeur si elle n'a qu'un champ texte, sinon le JSON. */
function excerptOfInput(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') return input;
  if (typeof input === 'object') {
    const values = Object.values(input as Record<string, unknown>);
    if (values.length === 1 && typeof values[0] === 'string') return values[0];
    try {
      return JSON.stringify(input);
    } catch {
      return null;
    }
  }
  return String(input);
}

function RawExcerpt({ text }: { text: string | null }) {
  if (text === null) return null;
  const t = text.length > 160 ? text.slice(0, 159) + '…' : text;
  return <span className="text-mono-11 text-ink-4">{t}</span>;
}
