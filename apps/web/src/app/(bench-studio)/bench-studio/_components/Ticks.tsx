// L'état d'abord, les chiffres ensuite : les coches d'essais, la barre empilée
// d'une activité, la barre de verts d'un modèle. Les couleurs sont les jetons
// sémantiques du design system (ok, err, warn, ink-4), lisibles dans les deux
// thèmes. Rien n'est compté ici : chaque nombre vient de results.ts.
import Link from 'next/link';
import { dollars, duree } from '@nodal-agents/bench/results';
import { when } from './format';

export interface TickTrial {
  readonly n: number | null;
  readonly verdict: string;
  readonly startedAt: string | null;
  readonly durationMs: number | null;
  readonly costUsd: number | null;
}

/** La couleur d'un verdict : vert, rouge, ambre pour une erreur du banc, gris pour un essai sauté. */
const TONE: Record<string, string> = {
  green: 'bg-ok',
  red: 'bg-err',
  error: 'bg-warn',
  skipped: 'bg-ink-4',
};

const VERDICT_WORD: Record<string, string> = {
  green: 'green',
  red: 'red',
  error: 'bench error',
  skipped: 'skipped',
};

function tickTitle(t: TickTrial): string {
  return [
    when(t.startedAt),
    VERDICT_WORD[t.verdict] ?? t.verdict,
    t.verdict === 'skipped' ? null : duree(t.durationMs),
    t.verdict === 'skipped' ? null : dollars(t.costUsd),
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Les derniers essais d'une cellule, une coche par essai, du plus ancien au
 * plus récent. Les places sans essai restent vides (un contour), à gauche :
 * le plus récent est toujours la dernière coche.
 */
export function TrialTicks({
  trials,
  slots = 5,
  size = 'md',
}: {
  trials: readonly TickTrial[];
  slots?: number;
  size?: 'sm' | 'md';
}) {
  const empty = Math.max(0, slots - trials.length);
  const dim = size === 'md' ? 'h-5 w-2' : 'h-4 w-1.5';
  return (
    <span
      className="inline-flex items-end gap-[3px]"
      aria-label={trials.map((t) => t.verdict).join(', ') || 'no trial'}
    >
      {Array.from({ length: empty }, (_, i) => (
        <span key={`e${i}`} className={`${dim} rounded-[2px] border border-rule`} aria-hidden />
      ))}
      {trials.map((t, i) => {
        const cls = `${dim} block rounded-[2px] ${TONE[t.verdict] ?? 'bg-warn'}`;
        return t.n === null ? (
          <span key={i} className={cls} title={tickTitle(t)} />
        ) : (
          <Link
            key={i}
            href={`/bench-studio/results/${t.n}`}
            title={tickTitle(t)}
            aria-label={tickTitle(t)}
            className={`${cls} transition-transform hover:scale-y-110`}
          />
        );
      })}
    </span>
  );
}

/** Verts, non verts, sautés : une barre empilée, proportionnelle aux essais montrés. */
export function StackBar({
  green,
  notGreen,
  skipped,
}: {
  green: number;
  notGreen: number;
  skipped: number;
}) {
  const total = green + notGreen + skipped;
  if (total === 0)
    return (
      <span className="block h-2 w-full max-w-36 rounded-full bg-hover" aria-label="no trial" />
    );
  const part = (n: number, tone: string, word: string) =>
    n === 0 ? null : (
      <span
        className={`h-full ${tone}`}
        style={{ width: `${(100 * n) / total}%` }}
        title={`${n} ${word}`}
      />
    );
  return (
    <span
      className="flex h-2 w-full max-w-36 overflow-hidden rounded-full bg-hover"
      aria-label={`${green} green, ${notGreen} not green, ${skipped} skipped`}
    >
      {part(green, 'bg-ok', 'green')}
      {part(notGreen, 'bg-err', 'not green')}
      {part(skipped, 'bg-ink-4', 'skipped')}
    </span>
  );
}

/** La part de verts d'un modèle, en barre ; vide quand rien n'a été tenté. */
export function RateBar({ green, tried }: { green: number; tried: number }) {
  return (
    <span
      className="block h-1.5 w-full max-w-32 overflow-hidden rounded-full bg-hover"
      aria-label={tried === 0 ? 'no trial' : `${green} of ${tried} green`}
    >
      {tried > 0 && (
        <span className="block h-full bg-ok" style={{ width: `${(100 * green) / tried}%` }} />
      )}
    </span>
  );
}

/** La légende des coches, une fois par écran. */
export function TickLegend() {
  const item = (tone: string, word: string, outline = false) => (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-3 w-1.5 rounded-[2px] ${outline ? 'border border-rule' : tone}`} />
      {word}
    </span>
  );
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body-12 text-ink-3">
      {item('bg-ok', 'green')}
      {item('bg-err', 'red')}
      {item('bg-warn', 'bench error')}
      {item('bg-ink-4', 'skipped')}
      {item('', 'no trial', true)}
      <span className="text-ink-4">oldest to newest, hover a tick for its date, time and cost</span>
    </span>
  );
}

/** L'en-tête d'une colonne de modèle : son nom, sa barre de verts, puis ses médianes. */
export function ColumnHead({
  name,
  help,
  green,
  tried,
  skipped,
  medianMs,
  medianUsd,
  totalUsd,
  unknownCost,
}: {
  name: string;
  help: string | null;
  green: number;
  tried: number;
  skipped: number;
  medianMs: number | null;
  medianUsd: number | null;
  totalUsd: number;
  unknownCost: number;
}) {
  return (
    <span
      className="flex min-w-36 flex-col gap-1.5 normal-case tracking-normal"
      title={help ?? undefined}
    >
      <span className="text-medium-12 text-ink">
        {name}
        {help !== null && <span className="text-ink-4"> ⓘ</span>}
      </span>
      <RateBar green={green} tried={tried} />
      <span className="text-mono-11 text-ink-2">
        {tried === 0
          ? 'no trial'
          : `${Math.round((100 * green) / tried)}% green · ${green}/${tried}`}
        {skipped > 0 ? ` · ${skipped} skipped` : ''}
      </span>
      <span className="text-mono-11 text-ink-4">
        {green > 0 ? `${duree(medianMs)} · ${dollars(medianUsd)} median` : 'no green trial'}
      </span>
      <span className="text-mono-11 text-ink-4">
        {dollars(totalUsd)} total{unknownCost > 0 ? ` + ${unknownCost} unknown` : ''}
      </span>
    </span>
  );
}
