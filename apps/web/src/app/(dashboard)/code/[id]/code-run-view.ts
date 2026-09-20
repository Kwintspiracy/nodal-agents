// code-run-view.ts — ce que la page d'un process de code LIT dans son détail.
//
// `/code/[id]` montre un run, comme `/scheduled/[id]` et `/jobs/[id]` : depuis
// le 18/09 elle se dessine avec les mêmes blocs, dans le même ordre. Ce qui
// diffère est la DONNÉE — `getCodingProcessDetailAction` rend un pipeline de
// code, pas un fil de job — donc tout le travail de cette page est une
// TRADUCTION. Elle vit ici, pure et testable, et l'écran ne fait que dessiner.
//
// Règle unique, celle de toute la planche : ce que la donnée ne dit pas ne
// s'écrit pas. Pas de 0 pour « inconnu », pas de nom d'agent deviné, pas de
// branche git inventée (le détail n'en porte aucune).

import type { CodingActivityItem, CodingProcessDetail, CodingToolCallView } from '@/lib/actions.ts';
import type { StatusVariant } from '@/components/ui/StatusPill';
import type { DeliverySummary, Step, TurnUsage } from '@/lib/conversation-feed.ts';
import { outcomeOfToolOutput } from '@/lib/tool-card-payload.ts';
import { lastReviewVerdict } from '@/lib/review-state.ts';
import { reviewBlocksDelivery } from '@nodal-agents/shared';
import type { ThreadAgent } from '@/app/(dashboard)/spaces/format.ts';
import { formatMs, formatTokens } from '@/app/(dashboard)/spaces/format.ts';
import { relativeTime } from '@/lib/format-time';
import { UNKNOWN, type RunStat } from '@/app/(dashboard)/runs/run-view.ts';

type CodeHeader = CodingProcessDetail['header'];

/** Les étapes où le process est encore VIVANT — la sonde continue de tourner. */
export const LIVE_STAGES = new Set(['coding', 'delegated', 'review', 'awaiting_approval']);

export function codeIsLive(stage: string): boolean {
  return LIVE_STAGES.has(stage);
}

const STAGE_LABEL: Record<string, string> = {
  coding: 'Coding',
  delegated: 'Delegated',
  review: 'Review',
  done: 'Done',
  done_approved: 'Done · Approved',
  failed: 'Failed',
  chat: 'Chat',
  awaiting_approval: 'Blocked · needs approval',
};

/**
 * L'état du process, d'un mot. Une étape que cette table ne connaît pas
 * s'écrit telle quelle : se faire ranger d'office dans « Idle » serait une
 * invention (invariant #4).
 */
export function codeStatus(stage: string): { variant: StatusVariant; label: string } {
  const label = STAGE_LABEL[stage] ?? stage;
  if (stage === 'coding' || stage === 'delegated' || stage === 'review') {
    return { variant: 'run', label };
  }
  if (stage === 'done' || stage === 'done_approved') return { variant: 'done', label };
  if (stage === 'failed' || stage === 'awaiting_approval') return { variant: 'warn', label };
  return { variant: 'idle', label };
}

/**
 * D'OÙ vient ce run, en texte nu — jamais en pastille (Quentin, 18/09).
 *
 * La planche écrit « code · branch fix/unfold-keeps-scroll ». Le détail d'un
 * process ne porte AUCUNE branche : il porte le projet dérivé des fichiers
 * touchés. C'est donc lui qu'on nomme, et à défaut la provenance de la session
 * — jamais une branche devinée.
 */
export function codeOrigin(header: Pick<CodeHeader, 'origin' | 'projectName'>): string {
  const what = header.projectName ?? header.origin;
  return what === '' || what === 'code' ? 'code' : `code · ${what}`;
}

/**
 * Le HARNAIS et le modèle qui ont exécuté, en texte de la couleur du modèle.
 *
 * `providers` dit quel CLI a tourné (`claude`, `codex`) — la seule façon de
 * lire un run pour la sécurité et de lui attribuer son coût. Le modèle vient
 * du premier marqueur de tour qui en nomme un ; aucun n'en nomme ⇒ le harnais
 * seul, et si le harnais lui-même est inconnu, `null` et rien ne se dessine.
 */
export function codeRuntime(
  header: Pick<CodeHeader, 'providers'>,
  activity: readonly CodingActivityItem[],
): string | null {
  const model =
    activity.flatMap((i) => (i.kind === 'turn' ? (i.modelUsage ?? []) : [])).find((m) => m.model)
      ?.model ?? null;
  const parts = [...header.providers, ...(model === null ? [] : [model])];
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * Les sept cases de l'en-tête — les mêmes que celles d'un run d'agent, aux
 * mêmes mots : deux écrans qui montrent un run ne nomment pas ses chiffres
 * différemment. Les valeurs sont celles que le détail calcule déjà.
 */
export function codeStats(header: CodeHeader): RunStat[] {
  return [
    { label: 'Cost', value: header.costUsd > 0 ? `$${header.costUsd.toFixed(2)}` : UNKNOWN },
    {
      label: 'Duration',
      value: header.durationMs !== null ? formatMs(header.durationMs) : UNKNOWN,
    },
    {
      label: 'Input tokens',
      value: header.inputTokens > 0 ? formatTokens(header.inputTokens) : UNKNOWN,
    },
    {
      label: 'Output tokens',
      value: header.outputTokens > 0 ? formatTokens(header.outputTokens) : UNKNOWN,
    },
    {
      label: 'Cache reads',
      value: header.cachedTokens > 0 ? formatTokens(header.cachedTokens) : UNKNOWN,
    },
    { label: 'Files changed', value: String(header.filesChanged) },
    { label: 'Activity', value: relativeTime(header.activityAt) },
  ];
}

/**
 * Où mène le bouton « Files » de la barre : la page du dossier du projet.
 *
 * Seulement quand le dossier est un projet ENREGISTRÉ — c'est cette ligne-là
 * qui porte un identifiant, et elle seule ouvre une page. Un dossier jamais
 * déclaré, ou une session de runtime, n'en a pas : `null`, et la barre ne
 * dessine pas de bouton plutôt que d'en poser un qui ne mène nulle part.
 */
export function codeFilesHref(header: Pick<CodeHeader, 'projectId'>): string | null {
  return header.projectId === null ? null : `/spaces/${header.projectId}/files`;
}

/**
 * D'où l'on vient, depuis la page d'un run de code (#143).
 *
 * « Back to Code » ne veut plus rien dire : la liste Code a disparu et sa route
 * redirige. Le retour mène donc au PROJET quand le run en a un d'enregistré —
 * c'est de là qu'on a cliqué, son onglet Activity porte cette ligne — et à
 * Workspaces sinon. Jamais vers une route qui rebondit : une redirection au
 * retour fait clignoter l'écran et perd la position de défilement.
 */
export function codeBackLink(header: Pick<CodeHeader, 'projectId'>): {
  label: string;
  href: string;
} {
  return header.projectId === null
    ? { label: 'Back to workspaces', href: '/spaces' }
    : { label: 'Back to the project', href: `/spaces/${header.projectId}` };
}

/**
 * Les agents qui ont travaillé : celui du process, puis les délégués nommés
 * par les lignes d'audit, dans l'ordre où ils paraissent. Dédoublonnés par NOM
 * — le détail d'un process ne porte pas de slug. Chacun avec son image quand il
 * en a une (18/09) : la barre montre des visages, comme sur les deux autres
 * pages de run ; sans image, ses initiales, jamais un portrait inventé.
 */
export function codeAgents(
  header: Pick<CodeHeader, 'agentName' | 'agentAvatarUrl'>,
  activity: readonly CodingActivityItem[],
): ThreadAgent[] {
  const out: ThreadAgent[] = [];
  const seen = new Set<string>();
  const push = (name: string | null, avatarUrl: string | null): void => {
    if (name === null || name === '') return;
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ key: name, name, avatarUrl });
  };
  push(header.agentName, header.agentAvatarUrl);
  for (const item of activity) {
    if (item.kind === 'call' && item.delegatedFrom) {
      push(item.delegatedFrom.agentName, item.delegatedFrom.agentAvatarUrl);
    }
  }
  return out;
}

/** Ce que la ligne d'Activity dit d'elle-même : « 11 steps · 2 agents · 6 min 48 ». */
export function codeActivityLabel(
  header: Pick<CodeHeader, 'agentName' | 'agentAvatarUrl' | 'durationMs'>,
  activity: readonly CodingActivityItem[],
): string {
  const agents = codeAgents(header, activity).length;
  const parts = [`${activity.length} ${activity.length === 1 ? 'step' : 'steps'}`];
  if (agents > 0) parts.push(`${agents} ${agents === 1 ? 'agent' : 'agents'}`);
  if (header.durationMs !== null && header.durationMs > 0) parts.push(formatMs(header.durationMs));
  return parts.join(' · ');
}

/**
 * CE QUE LE RUN A LIVRÉ, dans la forme que le bloc du fil sait dessiner.
 *
 * Chaque champ vient d'une donnée que le détail porte VRAIMENT : les fichiers
 * et leurs lignes des groupes de changements, les commandes de preuve des
 * séquences de vérification, la durée et le coût de l'en-tête. Deux champs
 * restent vides, et c'est dit ici plutôt que rempli au jugé :
 *
 *   - `reviews` — le bloc y nomme QUI a relu ; un verdict de code ne porte que
 *     l'identifiant du job qui l'a rendu, pas le nom de son agent. La section
 *     Review, juste dessous, montre les verdicts en entier.
 *   - `filePaths` porte les chemins tels que le pipeline les a écrits.
 *
 * `null` quand le run n'a RIEN à montrer — ni fichier, ni preuve : un cadre
 * « Delivered » vide affirmerait une livraison qui n'a pas eu lieu.
 */
export function codeDelivery(detail: CodingProcessDetail): DeliverySummary | null {
  const { header, changes, verificationRuns, verdicts } = detail;
  const commands = verificationRuns.flatMap((s) => s.runs);
  if (changes.length === 0 && commands.length === 0) return null;
  const added = changes.reduce((acc, c) => acc + c.addedLines, 0);
  const removed = changes.reduce((acc, c) => acc + c.removedLines, 0);
  const passed = commands.filter((r) => r.verdict === 'green').length;
  const review = lastReviewVerdict(verdicts);
  return {
    files: changes.length,
    filePaths: changes.map((c) => c.filePath),
    lines: added === 0 && removed === 0 ? null : { added, removed },
    tests: commands.length > 0 ? { passed, total: commands.length } : null,
    durationMs: header.durationMs,
    costUsd: header.costUsd > 0 ? header.costUsd : null,
    reviews: [],
    checks: commands.map((r) => ({ command: r.command, ok: r.verdict === 'green' })),
    verdict: commands.length === 0 ? null : passed === commands.length ? 'green' : 'red',
    // #59 — la relecture du pipeline, déjà lue pour la section Review juste
    // dessous. Le bloc dit « Delivered » quoi qu'il arrive et pose ce verdict à
    // côté ; c'est là que « Changes requested » ou « Approved » se lit.
    review,
    changesRequested: reviewBlocksDelivery(review),
    // LE DÉTAIL D'UN PROCESS DE CODE NE PORTE AUCUNE COMMANDE de ce genre
    // (#282) : il porte les commandes de PREUVE (`verificationRuns`, déjà
    // rendues dans `checks`), jamais les appels shell du travail ni le constat
    // d'écriture de leur tour. Une liste vide, donc — pas une invention.
    commands: [],
    // CE QUE LA GARDE DU DESSUS GARANTIT, et rien de plus (Reviewer C, passe 1
    // de la PR #327) : arrivé ici, le run a écrit des fichiers OU fait tourner
    // une preuve. Un run de preuve seule, sans un fichier changé, passe donc
    // avec `produced: true` et garde le mot « Delivered » — c'est ce que cette
    // page affiche depuis toujours, et #282 ne touche pas à cette question-là.
    // Le mot ne peut de toute façon pas mentir ici par la porte de #282 : cette
    // page ne porte aucune commande non constatée à lui opposer.
    produced: true,
  };
}

/**
 * Un appel que le harnais a REFUSÉ — il n'a rien fait. Lu sur l'enveloppe
 * `<tool_use_error>` du CLI, ou sur le `{"ok":false}` d'un outil Nodal. Gardé
 * VISIBLE et signalé plutôt que caché : « cet agent a tenté d'écrire et a été
 * bloqué » est le signal qui dit que sa posture est mauvaise — celui qui
 * manquait pendant qu'un agent en lecture seule avait l'air de coder.
 *
 * `outcomeOfToolOutput` ne le voit pas : il lit un champ `outcome` dans du
 * JSON, et l'enveloppe du CLI n'en est pas. Les deux se composent donc.
 */
export function isRefusedCall(toolOutput: string | null): boolean {
  if (toolOutput === null) return false;
  const head = toolOutput.slice(0, 400);
  return head.includes('<tool_use_error>') || /^\s*\{"ok"\s*:\s*false\b/.test(head);
}

/**
 * Un appel d'outil du process, dans la forme d'un BLOC DU FIL.
 *
 * C'est la traduction qui permet de dessiner l'activité d'un run de code avec
 * `ToolBlock` — le même bloc, la même ligne repliée, les mêmes plaques de code
 * dépliées — au lieu d'une seconde famille de lignes qui aurait vieilli à part.
 *
 * `card` et `presented` restent nuls : un appel de CLI n'a pas de carte
 * persistée, et le bloc le DIT (« no card recorded ») au lieu de résumer une
 * charge utile qui n'existe pas. L'issue se lit sur la sortie brute, par la
 * même fonction que le fil (`outcomeOfToolOutput`) : un appel refusé par le
 * harnais se voit, il ne se devine pas.
 */
export function toolStepOfCall(
  tc: CodingToolCallView,
  jobId: string,
): Extract<Step, { kind: 'tool' }> {
  return {
    kind: 'tool',
    toolName: tc.toolName,
    toolCallId: tc.id,
    jobId: tc.delegatedFrom?.jobId ?? jobId,
    card: null,
    presented: null,
    input: tc.toolInput,
    outputText: tc.toolOutput,
    outcome: isRefusedCall(tc.toolOutput) ? 'error' : outcomeOfToolOutput(tc.toolOutput),
    durationMs: tc.durationMs,
    lineCounts: {},
    question: null,
  };
}

/**
 * Un marqueur de tour, dans la forme que le bloc d'appel de modèle lit.
 *
 * Le détail d'un process ne date pas ses tours et n'en connaît pas la durée :
 * `durationMs` vaut 0, et le bloc ne dessine alors aucune durée — il ne dessine
 * que ce qui est non nul. `calls` vaut 1 : c'est UN tour ; le bloc ne l'affiche
 * pas, il appartient à la forme.
 */
export function turnUsageOf(item: Extract<CodingActivityItem, { kind: 'turn' }>): TurnUsage {
  return {
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    cachedTokens: item.cachedTokens,
    cacheCreationTokens: item.cacheCreationTokens ?? 0,
    costUsd: item.costUsd > 0 ? item.costUsd : null,
    durationMs: 0,
    calls: 1,
  };
}

/**
 * Les lignes de modèle d'un tour : une par modèle quand le fournisseur a
 * rendu le détail (un tour de CLI peut servir deux modèles, 0079), sinon une
 * seule, celle du tour entier.
 */
export function turnModelLines(
  item: Extract<CodingActivityItem, { kind: 'turn' }>,
): Array<{ model: string | null; usage: TurnUsage }> {
  if (item.modelUsage !== null && item.modelUsage.length > 1) {
    return item.modelUsage.map((m) => ({
      model: m.model,
      usage: {
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        cachedTokens: m.cachedTokens,
        cacheCreationTokens: m.cacheCreationTokens ?? 0,
        costUsd: m.costUsd ?? null,
        durationMs: 0,
        calls: 1,
      },
    }));
  }
  return [{ model: item.modelUsage?.[0]?.model ?? null, usage: turnUsageOf(item) }];
}
