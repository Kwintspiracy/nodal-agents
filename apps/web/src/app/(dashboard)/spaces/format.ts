// format.ts — les mots et les nombres du fil (P2). Le modèle
// (`conversation-feed.ts`) ne porte que la structure ; c'est ici que la carte
// devient un mot, et un nombre un chiffre lisible. Copy courte, en anglais
// comme le reste du tableau de bord.

import type { FeedItem, Origin } from '@/lib/conversation-feed.ts';
import { formatClock } from '@/lib/format-time';

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

/**
 * Quand le fil a COMMENCÉ, dans la langue courte de l'en-tête (#135) :
 * « started today 14:01 », « started yesterday 09:30 », sinon une date brève
 * (« started Sep 12 14:01 »). Le jour se compare sur le calendrier local, pas
 * sur un écart d'heures : un fil ouvert à 23 h 50 est encore « yesterday » à
 * 00 h 10, jamais « today ».
 *
 * `null` quand la date manque — l'en-tête ne dessine alors PAS le morceau,
 * plutôt qu'un « started — » (invariant #4).
 */
export function startedLabel(at: Date | null): string | null {
  if (at === null) return null;
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const elapsed = Math.round((day(new Date()) - day(at)) / 86_400_000);
  // L'année ne s'écrit que si ce n'est pas celle d'aujourd'hui : « Sep 12 »
  // suffit pour un fil de la semaine dernière, mais « Sep 12 » pour un fil de
  // l'an passé mentirait par omission (revue Reviewer C, PR #144).
  const sameYear = at.getFullYear() === new Date().getFullYear();
  const when =
    elapsed === 0
      ? 'today'
      : elapsed === 1
        ? 'yesterday'
        : at.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            ...(sameYear ? {} : { year: 'numeric' }),
          });
  return `started ${when} ${formatClock(at)}`;
}

/**
 * Le sous-titre d'un en-tête de fil : d'où vient la demande, et quand le fil
 * s'est ouvert. Le second morceau disparaît quand la date manque, et la
 * provenance garde SES mots (« via Telegram », « from the dashboard »).
 */
export function threadSubtitle(origin: string, at: Date | null): string {
  const started = startedLabel(at);
  return started === null ? origin : `${origin} · ${started}`;
}

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

/** Un agent du fil, tel que l'en-tête de travail l'affiche. */
export type ThreadAgent = { key: string; name: string; avatarUrl?: string | null };

/**
 * Les agents qui ont travaillé dans ce fil, dans l'ordre où ils y paraissent :
 * ceux qui ont pris un tour, puis ceux à qui on a délégué (et les leurs, quand
 * l'appelant a construit leur fil). Dédoublonnés par SLUG — deux agents
 * peuvent porter le même nom d'affichage, et le même agent peut changer de nom
 * entre deux jobs ; le slug est ce qui l'identifie. Sans slug, le nom sert de
 * clé, faute de mieux.
 *
 * Un agent sans nom NI slug n'est pas compté : « 3 agents » dont un anonyme
 * serait un compte inventé.
 */
export function threadAgents(items: readonly FeedItem[]): ThreadAgent[] {
  const out: ThreadAgent[] = [];
  const seen = new Set<string>();
  const push = (name: string | null, slug: string | null, avatarUrl: string | null): void => {
    const key = slug ?? name;
    if (key === null || key === '') return;
    if (seen.has(key)) return;
    seen.add(key);
    // L'image de l'agent voyage avec lui : la barre montre le vrai avatar
    // quand il y en a un, les initiales sinon (Quentin, 17/09).
    out.push({ key, name: name ?? key, avatarUrl });
  };
  const walk = (list: readonly FeedItem[]): void => {
    for (const item of list) {
      if (item.kind === 'turn') push(item.agent.name, item.agent.slug, item.agent.avatarUrl);
      // #135 — le travail d'un run vit dans un GROUPE depuis #132 : ses tours
      // et ses délégations y sont, plus au niveau du fil. Sans cette descente,
      // la barre d'un fil replié n'aurait plus montré aucun agent.
      else if (item.kind === 'run') walk(item.items);
      else if (item.kind === 'child') {
        push(item.job.agentName, item.job.agentSlug, item.job.agentAvatarUrl);
        if (item.job.feed) walk(item.job.feed.items);
      }
    }
  };
  walk(items);
  return out;
}
