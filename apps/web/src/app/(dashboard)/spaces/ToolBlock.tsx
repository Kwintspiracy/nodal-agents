'use client';

// ToolBlock — UN appel d'outil, sur UNE ligne, dépliable (#135).
//
// Le tableau de Quentin pose un principe pour tous les blocs d'un run : replié,
// chaque bloc tient sur une seule ligne ; chacun se déplie pour son compte.
// Replié n'est pas caché — la ligne dit déjà le nom de l'outil, son argument,
// comment l'appel s'est terminé et combien de temps il a pris. Ce qui demandait
// jusqu'ici une deuxième ligne de 31 px (le résumé du résultat) descend dans le
// corps, avec l'entrée complète.
//
// Une ligne, une police, une taille : ce qui distingue les choses est la
// COULEUR — le nom de l'outil en `feed/tool`, son argument en `feed/argument`,
// les durées en `feed/metric`.
//
// Le corps déplié, lui, est du CODE : l'entrée et le résultat passent par
// `CodeBlock`, qui les colore quand c'est du JSON et offre de les copier —
// sans numéros de ligne : une charge utile n'est pas un fichier (Quentin,
// 18/09). Un gros bloc gris en petite police grise n'est pas une lecture.
//
// Composant CLIENT depuis #135 : le dépliage est un état du navigateur. Le coût
// est assumé (issue #132) ; ce fichier n'importe rien de serveur-seulement, et
// `RunRow` — l'autre appelant — est déjà client.

import { List } from '@phosphor-icons/react/dist/ssr';
import FoldableBlock, { FoldableBody } from './FoldableBlock.tsx';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import CodeBlock from '@/components/ui/CodeBlock';
import type { Step } from '@/lib/conversation-feed.ts';
import { prettyJson } from '@/lib/json-tokens.ts';
import { formatMs, shortToolName } from './format.ts';

type ToolStep = Extract<Step, { kind: 'tool' }>;

/**
 * La pastille de 8 px qui dit comment l'appel s'est terminé. Exportée : la
 * carte d'envoi la reprend telle quelle — deux blocs d'un même run ne disent
 * pas leur issue de deux couleurs différentes.
 */
export const DOT: Readonly<Record<string, string>> = {
  success: 'bg-ok',
  error: 'bg-err',
  blocked: 'bg-err',
  awaiting_approval: 'bg-run',
};

/**
 * L'entrée d'un appel, en une ligne : la valeur si elle n'a qu'un champ texte,
 * sinon les champs `clé=valeur`. Coupée à 60 caractères — c'est un repère, pas
 * une transcription ; l'entrée entière vit dans le corps déplié.
 */
export function excerptOfInput(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  let text: string | null = null;
  if (typeof input === 'string') text = input;
  else if (typeof input === 'object') {
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length === 0) return null;
    if (entries.length === 1 && typeof entries[0]?.[1] === 'string') {
      text = entries[0][1] as string;
    } else {
      text = entries
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
    }
  } else text = String(input);
  if (text === null || text === '') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/**
 * Le corps a-t-il quelque chose à dire ? Sans ça, un appel muet (pas de charge
 * utile, pas de sortie, pas d'entrée) offrirait un chevron qui n'ouvre rien —
 * ce qui se lit comme un bug, pas comme « rien à dire ». Un tel appel garde sa
 * ligne, sans bouton.
 */
export function hasBody(step: ToolStep): boolean {
  if (step.outcome !== 'success') return true;
  if (step.presented !== null) return true;
  if (step.outputText !== null && step.outputText.trim() !== '') return true;
  return excerptOfInput(step.input) !== null;
}

/** Ce que l'entrée donne à lire, en clair ; `null` quand il n'y a pas d'entrée. */
function inputJson(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'object' && Object.keys(input as object).length === 0) return null;
  return JSON.stringify(input, null, 2);
}

/**
 * L'aveu d'un bloc BRUT : aucune charge utile n'a été persistée pour cet appel,
 * soit qu'aucune carte n'ait été enregistrée, soit que celle qui l'a été ne se
 * lise pas. Le fait compte pour le propriétaire — un bloc brut dit qu'il est
 * brut — mais il n'a pas à occuper la ligne repliée : il vit sous `Result`.
 */
function rawNote(step: ToolStep): string | null {
  if (step.presented !== null) return null;
  return step.card === null ? 'no card recorded' : `${step.card} · raw`;
}

export default function ToolBlock({ step }: { step: ToolStep }) {
  const arg = excerptOfInput(step.input);
  const head = (
    <>
      <List size={14} className="shrink-0 text-ink-4" aria-hidden />
      <span className="shrink-0 text-mono-12 text-feed-tool" title={step.toolName}>
        {shortToolName(step.toolName)}
      </span>
      {arg !== null && (
        <span className="min-w-0 flex-1 truncate text-mono-12 text-feed-argument">({arg})</span>
      )}
      <span
        className={`ml-auto h-2 w-2 shrink-0 rounded-full ${DOT[step.outcome] ?? 'bg-ink-4'}`}
        aria-hidden
      />
      {step.durationMs !== null && (
        <span className="shrink-0 text-mono-12 text-feed-metric">{formatMs(step.durationMs)}</span>
      )}
    </>
  );
  return <FoldableBlock head={head} {...(hasBody(step) ? { body: <Body step={step} /> } : {})} />;
}

/** Ce que l'appel a demandé, puis ce qu'il a rendu. */
function Body({ step }: { step: ToolStep }) {
  const json = inputJson(step.input);
  const note = rawNote(step);
  // Une carte lue se résume (`StepLine`) ; sans charge utile, le plus vrai
  // qu'on ait est la sortie telle qu'elle a été écrite — dans un bloc de code,
  // bornée en hauteur, jamais coupée en silence.
  const raw = step.presented === null && step.outcome === 'success';
  const failed = step.outcome === 'error' || step.outcome === 'blocked';
  return (
    <FoldableBody>
      {json !== null && (
        <>
          <p className="text-mono-11 text-ink-4">Input</p>
          <CodeBlock code={json} lang="json" className="" lineNumbers={false} />
        </>
      )}
      <p className="text-mono-11 text-ink-4">Result</p>
      {raw ? (
        <RawResult text={step.outputText ?? excerptOfInput(step.input) ?? ''} />
      ) : (
        <div className={`text-mono-12 break-words ${failed ? 'text-err' : 'text-ink-3'}`}>
          <StepLine step={step} />
        </div>
      )}
      {note !== null && <p className="text-mono-11 text-ink-4">{note}</p>}
    </FoldableBody>
  );
}

/**
 * La sortie BRUTE d'un appel, dans un bloc de code. Une sortie d'outil est du
 * JSON neuf fois sur dix : on la met en forme et on la colore. Le reste — une
 * ligne de log, un message d'erreur — reste du texte, sans pastille de langue,
 * parce que l'annoncer `json` serait faux.
 */
function RawResult({ text }: { text: string }) {
  const pretty = prettyJson(text);
  return pretty !== null ? (
    <CodeBlock code={pretty} lang="json" className="" lineNumbers={false} />
  ) : (
    <CodeBlock code={text} className="" lineNumbers={false} />
  );
}

/**
 * Ce qu'une étape dit de son résultat : depuis la charge utile persistée par
 * P1, sinon le brut. Déplacée telle quelle de `StepsGroup` (P2bis) — c'est la
 * seule chose que ce groupe savait faire et qui valait d'être gardée.
 */
export function StepLine({ step }: { step: ToolStep }) {
  if (step.outcome === 'error' || step.outcome === 'blocked') {
    return (
      <>
        {step.outcome} <RawExcerpt text={step.outputText} />
      </>
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
    case 'sent': {
      const chars =
        step.input !== null &&
        typeof step.input === 'object' &&
        typeof (step.input as { text?: unknown }).text === 'string'
          ? (step.input as { text: string }).text.length
          : null;
      return (
        <>
          to {p.target ?? p.channel}
          {chars !== null ? ` · ${chars} chars` : ''}
        </>
      );
    }
    case 'question':
      return (
        <>
          asked · {p.options?.length ?? 0} {p.options?.length === 1 ? 'option' : 'options'}
        </>
      );
    case 'delegation':
      return (
        <>
          to {p.to} · {p.ok ? 'done' : 'failed'}
        </>
      );
    case 'terminal':
      return (
        <>
          {p.command} · {p.timedOut ? 'timed out' : `exit ${p.exitCode ?? '?'}`}
        </>
      );
    case 'checks':
      return (
        <>
          {p.verdict === 'pass' ? 'approved' : 'changes requested'} · {p.total}{' '}
          {p.total === 1 ? 'finding' : 'findings'}
        </>
      );
    case 'generic':
      return (
        <>
          <MonoMicroTag tone="ink">raw</MonoMicroTag> <RawExcerpt text={step.outputText} />
        </>
      );
    default: {
      // Toutes les cartes ont leur ligne. Une carte NEUVE casse la compilation
      // ici plutôt que de rendre une pastille muette en silence.
      const unhandled: never = p;
      void unhandled;
      return null;
    }
  }
}

function RawExcerpt({ text }: { text: string | null }) {
  if (text === null) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  return <>{flat.length > 160 ? `${flat.slice(0, 159)}…` : flat}</>;
}
