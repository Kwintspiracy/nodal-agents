// approval-impact.ts — deterministic, code-generated IMPACT line for a gated
// tool call.
//
// WHY this exists: an approval card used to lean entirely on the AGENT's own
// optional `purpose`/`impact` free-text fields — short on explanation when
// the agent forgot to fill them, and inconsistent across tools. This is the
// opposite of that: a fixed, per-tool sentence computed HERE, in code, never
// by the LLM. Invariant #2 ("no hardcoded user-facing text in runner — LLM
// speaks or runner stays silent") does not apply to this line: it is
// platform UI describing what the ACTION does, not the agent's voice. It
// complements (never replaces) the agent's own `purpose` line, which still
// carries the "why".
//
// Used identically by the Telegram approval card (apps/runner) and the
// dashboard approvals page (apps/web) so a reviewer sees the same
// plain-language "what actually happens" regardless of channel.

import {
  isCatastrophicCommand,
  isDestructiveOrHeavyCommand,
  isInlineInterpreterEvalCommand,
  staticShellCategories,
  type StaticShellCategory,
} from './catastrophic-command';

/**
 * What each kind of action the checklist reads DOES, for the card (Reviewer A,
 * #582). The card named every heavy command "deletes/moves files, installs
 * software, or changes system state": a model download read as an install.
 * It now says the kinds the checklist read in this command, and only those.
 */
const KIND_IMPACT: Record<StaticShellCategory, string> = {
  delete_files: 'deletes files or discards changes',
  install_software: 'installs software or packages',
  download: 'downloads files from the internet',
  open_or_send: 'opens a program on the screen, prints or sends a message',
  stop_programs: 'stops other programs or services',
  system_settings: 'changes system settings, permissions or disks',
  inline_code: 'runs code written into the command',
};

/**
 * The kinds of action the given commands perform, as one clause. A command
 * flagged heavy by a pattern that no kind reads at the start of a program
 * (`git commit -m "rm old refs"`) is said as such, not given a kind it may not
 * have.
 */
function heavyKindsClause(cmds: readonly string[]): string {
  const kinds = [...new Set(cmds.flatMap((c) => staticShellCategories(c)))];
  if (kinds.length === 0) return 'matches a heavy-action pattern in its text';
  const said = kinds.map((k) => KIND_IMPACT[k]);
  return said.length === 1
    ? (said[0] ?? '')
    : `${said.slice(0, -1).join(', ')} and ${said[said.length - 1] ?? ''}`;
}

/**
 * Extract the executable names a shell command actually runs — the basename of
 * the first token of each pipeline/sequence segment (split on |, &&, ||, ;),
 * skipping env-var prefixes (FOO=bar cmd) and sudo. Capped at 3 names so the
 * line stays a line. Purely descriptive — the security verdict comes from the
 * classifiers below, never from this list.
 */
function commandBinaries(cmd: string): string[] {
  const names: string[] = [];
  for (const segment of cmd.split(/\||&&|\|\||;/)) {
    // Tokenize keeping quoted strings whole — a Windows path with spaces
    // ("C:\Program Files\...\node.exe") is ONE token, not two.
    const tokens = segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    let head = '';
    for (const t of tokens) {
      if (t === '' || t === 'sudo' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
      head = t;
      break;
    }
    if (!head) continue;
    // basename, strip quotes/extension noise: "C:\bin\python.exe" → python
    const base = head
      .replace(/^["']|["']$/g, '')
      .split(/[\\/]/)
      .pop();
    if (base) names.push(base.replace(/\.(exe|cmd|bat)$/i, ''));
    if (names.length >= 3) break;
  }
  return names;
}

/**
 * Descriptive risk verdict for a shell command, derived from the SAME
 * classifiers the approval gate uses (single source of truth — the card can
 * never say "read-only" about a command the gate flagged destructive).
 */
function describeCommandImpact(cmd: string): string {
  const bins = commandBinaries(cmd);
  const ran = bins.length > 0 ? `Runs \`${bins.join('` → `')}\`` : 'Runs a shell command';
  if (isCatastrophicCommand(cmd)) {
    return `${ran} — MACHINE-WIDE DESTRUCTIVE: refused even if approved (hardline floor).`;
  }
  if (isInlineInterpreterEvalCommand(cmd)) {
    return `${ran} — executes arbitrary inline code through an interpreter.`;
  }
  if (isDestructiveOrHeavyCommand(cmd)) {
    return `${ran} — destructive or heavy: ${heavyKindsClause([cmd])}.`;
  }
  return `${ran} — no destructive pattern detected (likely read/inspect).`;
}

/**
 * Deterministic one-line impact summary for a gated tool call. Only called
 * for calls that ARE gated (an approval_requests row exists) — every branch
 * below assumes the call already crossed some destructive/require-approval
 * threshold, so the wording doesn't hedge on "if" it matters.
 */
export function computeApprovalImpactLine(toolName: string, toolInput: unknown): string {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' && v.length > 0 ? v : '?');
  switch (toolName) {
    case 'file_write':
    case 'file_edit':
      return `Overwrites the existing file "${str(input['path'])}" in the shared workspace.`;
    case 'run_command': {
      const cmd = input['command'];
      return typeof cmd === 'string' && cmd.trim().length > 0
        ? describeCommandImpact(cmd)
        : 'Runs a shell command on the host.';
    }
    case 'run_skill_script':
      return `Runs script "${str(input['script'])}" from skill "${str(input['skill'])}".`;
    case 'skill_file_write':
      return `Writes a file into skill "${str(input['skill'])}"'s bundle.`;
    case 'declare_verification': {
      // Ce qu'on approuve ici, ce n'est pas une écriture en base : ce sont des
      // commandes qui tourneront À LA FINALISATION, sans repasser par une
      // approbation. Le catch-all « irreversible or destructive action »
      // demandait donc un accord SANS montrer sur quoi (revue Codex, PR #49,
      // passe 2). Les commandes sont dites, comme celles de `run_command`.
      const raw = input['commands'];
      const commands = Array.isArray(raw)
        ? raw
            .map((c) => (c as { command?: unknown })?.command)
            .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
        : [];
      if (commands.length === 0) {
        return `Records how "${str(input['project_path'])}" is verified — no command declared, so nothing will run.`;
      }
      const liste = commands.map((c) => `\`${c}\``).join(', ');
      const heavy = commands.filter((c) => isDestructiveOrHeavyCommand(c));
      return (
        `Records ${liste} as the proof for "${str(input['project_path'])}". ` +
        `${commands.length === 1 ? 'It runs' : 'They run'} when the job finishes, without asking again` +
        (heavy.length > 0 ? ` — and at least one ${heavyKindsClause(heavy)}.` : '.')
      );
    }
    case 'file_search': {
      // Gaté uniquement par une règle UTILISATEUR (riskLevel: read) — le
      // catch-all « irreversible or destructive » mentait sur une recherche
      // (constat live Quentin 25/08). Dire ce que c'est : une lecture.
      const pat = typeof input['pattern'] === 'string' ? ` for "${input['pattern']}"` : '';
      return `Searches workspace files${pat} — read-only, changes nothing.`;
    }
    case 'file_read':
      return `Reads the file "${str(input['path'])}" — read-only, changes nothing.`;
    case 'file_list':
      return `Lists workspace files — read-only, changes nothing.`;
    case 'code_task': {
      // Risque fonction de l'IMPACT réel (lot approbations, décision Quentin
      // 24/08) : un code_task tombait dans le default « irreversible or
      // destructive » alors que ses écritures sont checkpointées AVANT
      // exécution (mutatesWorkspace → takeCheckpointForTurn, verrouillé par
      // checkpoint-wiring.test.ts).
      //
      // Mais « réversible » sans réserve était FAUX (revue P0 du 25/08) : le
      // snapshot fait un `git add` ordinaire, donc tout ce que le .gitignore
      // du projet exclut (.env, données locales, caches) n'est PAS capturé —
      // le dépôt le documente lui-même (CHECKPOINT_COVERAGE_NOTE). Et le mode
      // 'read' ne modifie rien du tout : l'annoncer comme une écriture
      // apprend à ne plus lire la ligne d'impact.
      const mode = typeof input['mode'] === 'string' ? input['mode'] : 'read';
      if (mode !== 'write') {
        return 'Runs a coding agent in READ mode: it inspects the workspace and reports back, without editing files or running commands.';
      }
      return (
        'Runs a coding agent that edits files in the workspace. ' +
        'Tracked files are snapshotted first and can be reverted from the CLI; ' +
        'gitignored files (.env, local data) and the commands it runs are not.'
      );
    }
    case 'register_project': {
      // Créer un projet passe par l'approbation depuis P10b (revue Codex,
      // passes 39-41) : la carte est donc la SEULE chose que le propriétaire
      // lit avant de dire oui. Tombé dans le default, l'outil s'annonçait
      // « irreversible or destructive » — faux : un dossier créé s'il manque,
      // une ligne au registre, rien d'écrit ni d'effacé (revue Codex, passe 44).
      const path = typeof input['path'] === 'string' && input['path'] !== '' ? input['path'] : null;
      const kind = input['kind'] === 'code' ? 'code' : 'documents';
      return path
        ? `Creates the folder "${path}" in the workspace (if missing) and registers it as a ${kind} project in Spaces. No file is written or deleted.`
        : `Creates a folder in the workspace and registers it as a ${kind} project in Spaces. No file is written or deleted.`;
    }
    default:
      return `${toolName}: irreversible or destructive action.`;
  }
}
