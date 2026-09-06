// verification-runs-view.ts — la vue de LECTURE des preuves d'un run (plan
// « Vérifier & Corriger », T24 / D9) : ce que le détail de run montre des
// lignes `verification_runs`, et des traces D8 figées sur `agent_jobs`.
//
// Module pur, frère de verification-display.ts : actions.ts ('use server')
// l'appelle pour grouper, le composant client pour libeller. Aucun état de
// DÉCISION n'est rendu en ① (le plan garde « succès vérifié / bloqué » pour ②
// avec la garde) : les lignes ci-dessous sont de l'OBSERVATION — une commande,
// son code de sortie, sa durée, son verdict — et deux faits de configuration
// (surface hors vérification, projet sans commandes), jamais un jugement sur
// le job.

import { VERIFICATION_SURFACE_KEYS, type VerificationSurfaceKey } from '@nodal-agents/shared';

/** Une commande de preuve exécutée — miroir des colonnes de `verification_runs`. */
export type VerificationRunView = {
  jobId: string | null;
  sequenceId: string;
  commandRank: number;
  command: string;
  exitCode: number | null;
  /** 'exit' | 'timeout' | 'spawn_error' — le code du moteur, libellé par l'écran. */
  outcomeKind: string;
  durationMs: number | null;
  /** 'green' | 'red' | 'infra_error' */
  verdict: string;
  testedGeneration: number | null;
  testedEpoch: number | null;
  createdAt: string;
};

/** Une preuve = une exécution de `runCommandSequence` : N commandes, un verdict. */
export type VerificationSequenceView = {
  sequenceId: string;
  jobId: string | null;
  deliverableType: string;
  canonicalKey: string;
  /** Le verdict de la séquence : infra_error > red > green (fail-fast, la première rouge arrête). */
  verdict: string;
  startedAt: string;
  /** Triées par `commandRank`. */
  runs: VerificationRunView[];
};

/**
 * Un livrable que la preuve n'a PAS pu éprouver faute de configuration —
 * lu dans l'état par livrable, et rendu comme un fait de configuration (« pas
 * de commandes », « commandes en attente d'approbation »), pas comme un état
 * de décision.
 */
export type VerificationUnconfiguredView = {
  deliverableType: string;
  canonicalKey: string;
  displayPath: string | null;
  reason: 'not_configured' | 'pending_approval';
};

/**
 * L'état de vérification d'un DOCUMENT écrit par UN job du fil (P12).
 * `status` est la valeur brute de `decision_status`, telle que la base la
 * porte : l'écran la traduit en une phrase, il n'en fabrique jamais une qui
 * n'y est pas.
 *
 * Par (job, clé), pas par clé seule. La carte d'un classeur écrit montre ce
 * que CE job vient d'écrire ; l'état qui va avec est celui de ce job pour ce
 * document — c'est la ligne que l'intention de ce job a ouverte et que sa
 * finalisation a fermée, sous la règle des générations. Un état « par clé »
 * qui prenait la ligne la plus récente du fil mélangeait les jobs : un job A
 * qui finissait de vérifier sa génération APRÈS qu'un job B avait réécrit le
 * fichier posait « Verified » sur la carte de B, et toutes les cartes
 * historiques du fil portaient le même état quel que soit le job qui les
 * avait produites (revue Codex PR #46, passe 46). La table garantit une ligne
 * par (job, type, clé) : il n'y a rien à départager, donc rien à deviner.
 *
 * Ce que ceci ne dit pas, et ne prétend pas dire : si un job écrit deux fois
 * le même fichier, ses deux cartes lisent la même ligne — l'état de la
 * dernière génération. Dater chaque carte d'une génération est l'affaire du
 * vérificateur de documents (v7-B), pas de cette vue.
 */
export type DeliverableStatusView = { jobId: string; canonicalKey: string; status: string };

/**
 * La clé sous laquelle l'écran range et retrouve l'état d'un document : le
 * job qui l'a écrit ET l'identité du fichier. Une seule fonction pour les
 * deux gestes, sinon l'un des deux finit par oublier le job.
 */
export function deliverableStatusKey(jobId: string, canonicalKey: string): string {
  return `${jobId} ${canonicalKey}`;
}

/** Les états des documents du fil, un par (job, clé), triés pour être stables. */
export function deliverableStatuses(
  rows: ReadonlyArray<{
    jobId: string;
    deliverableType: string;
    canonicalKey: string;
    decisionStatus: string;
  }>,
): DeliverableStatusView[] {
  return rows
    .filter((r) => r.deliverableType === 'office_file')
    .map((r) => ({ jobId: r.jobId, canonicalKey: r.canonicalKey, status: r.decisionStatus }))
    .sort((a, b) => {
      const k = a.canonicalKey < b.canonicalKey ? -1 : a.canonicalKey > b.canonicalKey ? 1 : 0;
      if (k !== 0) return k;
      return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
    });
}

/** La ligne brute telle que l'action la lit — un sous-ensemble de VerificationRunRow. */
export type VerificationRunSource = {
  jobId: string | null;
  deliverableType: string;
  canonicalKey: string;
  sequenceId: string;
  commandRank: number;
  command: string;
  exitCode: number | null;
  outcomeKind: string;
  durationMs: number | null;
  verdict: string;
  testedGeneration: number | null;
  testedEpoch: number | null;
  createdAt: Date | null;
};

/**
 * Le verdict d'une séquence à partir de ses commandes : une infra_error prime
 * (la preuve n'a pas pu conclure), puis un rouge, sinon vert. Une séquence sans
 * commande n'existe pas (une ligne par commande) — le cas rend 'infra_error'
 * plutôt qu'un faux vert.
 */
export function sequenceVerdict(runs: ReadonlyArray<{ verdict: string }>): string {
  if (runs.length === 0) return 'infra_error';
  if (runs.some((r) => r.verdict === 'infra_error')) return 'infra_error';
  if (runs.some((r) => r.verdict === 'red')) return 'red';
  return 'green';
}

/**
 * Groupe les lignes par `sequenceId` — l'ordre des séquences est celui de leur
 * première commande (la plus ancienne d'abord), les commandes d'une séquence
 * sont triées par rang. L'ordre d'arrivée des lignes n'a aucune importance.
 */
export function groupVerificationRuns(
  rows: readonly VerificationRunSource[],
): VerificationSequenceView[] {
  const sorted = [...rows].sort((a, b) => {
    const ta = a.createdAt?.getTime() ?? 0;
    const tb = b.createdAt?.getTime() ?? 0;
    return ta - tb || a.commandRank - b.commandRank;
  });
  const bySequence = new Map<string, VerificationSequenceView>();
  for (const r of sorted) {
    const view: VerificationRunView = {
      jobId: r.jobId,
      sequenceId: r.sequenceId,
      commandRank: r.commandRank,
      command: r.command,
      exitCode: r.exitCode,
      outcomeKind: r.outcomeKind,
      durationMs: r.durationMs,
      verdict: r.verdict,
      testedGeneration: r.testedGeneration,
      testedEpoch: r.testedEpoch,
      createdAt: r.createdAt ? r.createdAt.toISOString() : '',
    };
    const existing = bySequence.get(r.sequenceId);
    if (existing) {
      existing.runs.push(view);
    } else {
      bySequence.set(r.sequenceId, {
        sequenceId: r.sequenceId,
        jobId: r.jobId,
        deliverableType: r.deliverableType,
        canonicalKey: r.canonicalKey,
        verdict: 'infra_error',
        startedAt: view.createdAt,
        runs: [view],
      });
    }
  }
  const sequences = Array.from(bySequence.values());
  for (const s of sequences) {
    s.runs.sort((a, b) => a.commandRank - b.commandRank);
    s.verdict = sequenceVerdict(s.runs);
  }
  return sequences;
}

/**
 * La trace D8 d'un pipeline : l'union des `verification_skipped_surfaces` de
 * ses jobs, dédoublonnée, dans l'ordre des clés connues (les inconnues après,
 * par ordre alphabétique — une trace n'est jamais jetée parce que l'écran ne
 * la connaît pas).
 */
export function mergeSkippedSurfaces(traces: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const trace of traces) {
    if (!Array.isArray(trace)) continue;
    for (const v of trace) if (typeof v === 'string' && v.length > 0) seen.add(v);
  }
  const known: readonly string[] = VERIFICATION_SURFACE_KEYS;
  return Array.from(seen).sort((a, b) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    if (ia !== -1 || ib !== -1) {
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    }
    return a.localeCompare(b);
  });
}

/** Le libellé de chaque surface — la même liste que le réglage de /settings. */
export const VERIFICATION_SURFACE_LABELS: Record<
  VerificationSurfaceKey,
  { label: string; hint: string }
> = {
  codeTask: { label: 'Coding tool', hint: 'code_task: a coding CLI called as a tool' },
  cliRuntime: { label: 'Claude Code / Codex agents', hint: 'agents that ARE a coding CLI session' },
  fileOps: { label: 'File tools', hint: 'file_write, file_edit, Office files' },
  shell: { label: 'Commands and scripts', hint: 'run_command, run_skill_script' },
};

/** Libellé d'une clé de trace — la clé brute quand l'écran ne la connaît pas. */
export function surfaceLabel(key: string): string {
  return (
    (VERIFICATION_SURFACE_LABELS as Record<string, { label: string } | undefined>)[key]?.label ??
    key
  );
}
