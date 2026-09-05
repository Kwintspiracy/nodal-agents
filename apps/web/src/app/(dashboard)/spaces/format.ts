// format.ts — les mots et les nombres du fil (P2). Le modèle
// (`conversation-feed.ts`) ne porte que la structure ; c'est ici que la carte
// devient un mot, et un nombre un chiffre lisible. Copy courte, en anglais
// comme le reste du tableau de bord.

import type { ToolCard } from '@nodal-agents/shared';
import type { Origin, Step } from '@/lib/conversation-feed.ts';

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min${s > 0 ? ` ${s.toString().padStart(2, '0')}` : ''}`;
}

export function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** null → "n/a" : un coût inconnu n'est pas un coût nul. */
export function formatCost(usd: number | null): string {
  if (usd === null) return 'n/a';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** D'où vient la demande, en un mot ou deux. */
export function originLabel(origin: Origin): string {
  if (origin.channel === 'cron') {
    return origin.scheduleName ? `via automation “${origin.scheduleName}”` : 'via automation';
  }
  if (origin.channel === 'api' || origin.channel === 'dashboard') return 'from the dashboard';
  if (origin.channel === 'internal') return 'from another agent';
  if (origin.channel === 'task-board') return 'from the task board';
  return `via ${origin.channel.charAt(0).toUpperCase()}${origin.channel.slice(1)}`;
}

/** Le mot d'une carte, pour compter ce qu'un groupe contient. */
const CARD_WORDS: Record<ToolCard, [string, string]> = {
  text: ['note', 'notes'],
  read: ['read', 'reads'],
  search: ['search', 'searches'],
  files: ['file change', 'file changes'],
  table: ['table', 'tables'],
  terminal: ['command', 'commands'],
  sent: ['message sent', 'messages sent'],
  checks: ['check', 'checks'],
  delegation: ['delegation', 'delegations'],
  question: ['question', 'questions'],
  generic: ['raw result', 'raw results'],
};

/**
 * Le titre d'un groupe replié, déduit de ses cartes : « reasoning · 2 reads ·
 * 1 search ». Un appel sans carte compte comme « call » ; un échec comme
 * « failed ». Jamais un nom d'outil.
 */
export function summarizeSteps(steps: readonly Step[]): string {
  const counts = new Map<string, number>();
  let reasoning = 0;
  let failed = 0;
  for (const s of steps) {
    if (s.kind === 'reasoning') {
      reasoning += 1;
      continue;
    }
    if (s.outcome === 'error' || s.outcome === 'blocked') {
      failed += 1;
      continue;
    }
    const key = s.card ?? 'call';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts: string[] = [];
  if (reasoning > 0) parts.push('reasoning');
  for (const [key, n] of counts) {
    if (key === 'call') {
      parts.push(`${n} ${n === 1 ? 'call' : 'calls'}`);
      continue;
    }
    const words = CARD_WORDS[key as ToolCard];
    parts.push(`${n} ${n === 1 ? words[0] : words[1]}`);
  }
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.length > 0 ? parts.join(' · ') : 'no action';
}
