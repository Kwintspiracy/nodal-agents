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
 * Le nom d'un outil tel qu'un humain le lit : sans le préfixe de serveur MCP
 * (`mcp_fetch__fetch_markdown` → `fetch_markdown`), sans le `cli:` du harnais.
 */
export function shortToolName(name: string): string {
  const mcp = /^mcp_[^_]+(?:_[^_]+)*__(.+)$/.exec(name);
  if (mcp?.[1]) return mcp[1];
  if (name.startsWith('cli:')) return name.slice(4);
  return name;
}

/**
 * Le titre d'un groupe replié, déduit de ses cartes : « reasoning · 2 reads ·
 * 1 search ». Quand la carte ne dit rien (`generic`, ou pas de carte), le nom
 * court de l'outil prend sa place — c'est la seule information honnête ; un
 * échec compte comme « failed ».
 */
export function summarizeSteps(steps: readonly Step[]): string {
  const counts = new Map<string, number>();
  const named = new Set<string>();
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
    // Une carte qui ne dit rien (`generic`, ou pas de carte) : le NOM de
    // l'outil est la seule information honnête — « 1 raw result » n'en est pas.
    if (s.card === null || s.card === 'generic') {
      named.add(shortToolName(s.toolName));
      continue;
    }
    counts.set(s.card, (counts.get(s.card) ?? 0) + 1);
  }
  const parts: string[] = [];
  if (reasoning > 0) parts.push('reasoning');
  for (const [key, n] of counts) {
    const words = CARD_WORDS[key as ToolCard];
    parts.push(`${n} ${n === 1 ? words[0] : words[1]}`);
  }
  for (const name of named) parts.push(name);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.length > 0 ? parts.join(' · ') : 'no action';
}
