// cli-runtime/run-job.ts — the JOB path of a runtime agent (étape E).
//
// executeJob diverts here as soon as the loaded agent has runtime !==
// 'nodal': the whole Nodal LLM loop is skipped and the turn is served by the
// user's own coding CLI. What stays Nodal's (the dispatcher role, said as-is
// to the user): the job lifecycle (claim/heartbeat/complete/fail — so
// reapers, parent delegation resume and the Runs page all keep working), the
// workspace as perimeter, the per-agent daily budget, session continuity per
// conversation, the audit (cli_runs + live tool_calls), and channel delivery
// of the final text VERBATIM (invariant #2).

import {
  cliSessions,
  toolCalls,
  eq,
  and,
  gte,
  inArray,
  sql,
  type AnyDrizzleDb,
} from '@nodal-agents/db';
import {
  buildSystemPrompt,
  type Agent,
  type ConversationContext,
} from '@nodal-agents/orchestration';
import {
  assertCliBudget,
  recordCliRun,
  assertRuntimeSessionKey,
  writeMutationIntent,
  attachProductionToProject,
} from '@nodal-agents/tools';
import { acquireWorkspaceLocks, WorkspaceLockedError, type HeldLocks } from './workspace-locks.ts';
import { DEFAULT_LIMITS } from '@nodal-agents/orchestration';
import { buildCliAuditRow } from './audit.ts';
import { failJob, touchJob } from '../job/state.ts';
import { loadConversationContext } from '../job/conversation-id.ts';
// LA liste des outils d'édition — la même que l'onglet Code et le bloc Runtime.
// Recopiée nulle part : une seconde copie aurait divergé au premier ajout.
import { EDIT_TOOLS, resolveScannedPath, scannedEditPath } from '../job/code-projects.ts';
import { finalizeJobSuccess } from '../job/finalize.ts';
import { drainDeliveries, prepareDelivery } from '../delivery/outbox.ts';
import { isDeliveryRefusal, resolveDeliveryTarget } from '../delivery/resolve-delivery-target.ts';
import { isAutoRunPaused } from '../approvals/rules.ts';
import { probeWorkspaceGit } from '../lib/workspace-git.ts';
import { type ClaudeTurnEvent } from './claude-turn.ts';
import { resolveRuntime, isCliSetupError, type CliTurnResult } from './provider.ts';

/** Per-turn wall clock budget — a runtime agent turn is a full CLI session run. */
const RUNTIME_TURN_TIMEOUT_MS = 900_000;

// A runtime agent is a full `Agent` PLUS its CLI settings — not a hand-picked
// subset. It started as a subset (id/entityId/personality and the cli fields),
// which was enough while this path only forwarded `personality` verbatim. The
// moment it began building the real system prompt, the subset became a trap:
// `buildSystemPrompt` reads name, role and model, none of which were carried,
// and the cast at the call site made the compiler accept it. The identity line
// ("You are <name>…") silently vanished from the prompt and buildBaselineBlock
// received undefined twice. Nothing errored — the prompt was just quietly
// poorer, which is the hardest kind of regression to notice.
//
// Extending `Agent` means the conversion already done in executeJob/runChatTurn
// is reused rather than duplicated, and the next field added to `Agent` is a
// compile error here instead of a silent omission.
export interface CliRuntimeAgentRow extends Agent {
  runtime: string;
  cliPermissions: { mode?: 'read' | 'write'; extraDisallowed?: string[] } | null;
  cliDefaults: {
    claude?: { model?: string; effort?: string };
    codex?: { model?: string; effort?: string };
  } | null;
}

export interface CliRuntimeJobRow {
  entityId: string | null;
  chatId: string | null;
  channel: string | null;
  conversationId: string | null;
  task: string | null;
  /** `agent_jobs.trigger_context` — un déclencheur cron/webhook peut imposer le canal de notification. */
  triggerContext: unknown;
}

/**
 * Le JobContext d une session CLI — UN seul endroit, traverse par les deux
 * chemins (job et chat).
 *
 * Il etait construit en double, et les deux copies ont derive : la #7 a livre la
 * conscience du depot, la #8 a cable buildSystemPrompt ici, et NI l un NI l
 * autre chemin ne passait `workspaceGit`. Le bloc git n est rendu que si ce
 * champ existe, donc l agent qui en a le plus besoin — celui qui EST une CLI de
 * code — ne l a jamais recu. Trouve parce qu une banniere d interface affirmait
 * le contraire, pas par un test.
 *
 * Une fonction pure, donc testable, et surtout : un seul endroit ou ajouter le
 * prochain champ.
 */
export function buildCliRuntimeJobContext(args: {
  origin: string;
  task?: string | null;
  chatId?: string | null;
  workspaceGit?: Awaited<ReturnType<typeof probeWorkspaceGit>>;
  /**
   * Les dossiers que la CLI a RÉELLEMENT — le partagé compris.
   *
   * Sans cette liste, `buildSystemPrompt` retombe sur une requête dans
   * `agent_workspaces`, où le workspace PARTAGÉ n'a pas de ligne : il est créé
   * et injecté à l'exécution. L'agent recevait donc l'accès au dossier de
   * transmission entre agents sans qu'on lui dise qu'il existe (revue Codex,
   * 27/08). C'est la panne du 26/08 en miroir, sur le chemin CLI cette fois :
   * le prompt et les outils ne voyaient pas les mêmes dossiers.
   */
  workspaces?: ReadonlyArray<{ label: string; path: string }>;
  /**
   * Le fil dont ce tour fait partie, et son projet courant (P6). Une session CLI
   * est une conversation comme une autre : elle doit savoir dans quel dossier
   * elle travaille, et depuis combien de tours.
   */
  conversation?: ConversationContext;
}): Parameters<typeof buildSystemPrompt>[2] {
  return {
    origin: args.origin,
    surface: 'cli-runtime',
    ...(args.task ? { task: args.task } : {}),
    ...(args.chatId ? { telegramChatId: args.chatId } : {}),
    ...(args.workspaceGit ? { workspaceGit: args.workspaceGit } : {}),
    ...(args.workspaces && args.workspaces.length > 0 ? { workspaces: args.workspaces } : {}),
    ...(args.conversation ? { conversation: args.conversation } : {}),
  };
}

/**
 * Les FICHIERS que le harnais a écrits pendant ce tour, en chemins absolus.
 *
 * Le seul signal disponible est l'audit : `tool_calls` reçoit une ligne par
 * outil interne de la CLI (voir `onEvent` plus haut), et les outils d'édition y
 * portent un nom connu ET le chemin édité dans `tool_input` — lu par la même
 * fonction que l'onglet Code et le bloc Runtime (`scannedEditPath`,
 * `resolveScannedPath`), pour qu'un tour situe ses écritures là où l'écran
 * les montre. On borne au tour courant par `created_at` — une écriture d'un
 * tour PRÉCÉDENT du même job ne dit rien de celui-ci.
 *
 * P5b : ce sont ces chemins qui servent de cibles au registre des projets,
 * parce qu'un dossier attaché SANS manifeste n'est pas un projet mais que
 * l'enfant où le harnais vient d'écrire peut l'être — avec le terrain entier
 * pour cible, le registre ne saurait pas lequel.
 *
 * Pourquoi pas `cli_runs` : il n'a aucun champ de fichiers changés (vérifié
 * dans packages/db/src/schema/cli-runs.ts). Pourquoi pas le disque : le
 * comparer avant/après coûterait un inventaire complet du terrain à chaque
 * tour, pour une question à laquelle l'audit répond déjà.
 */
async function harnessEdits(
  db: AnyDrizzleDb,
  jobId: string,
  since: Date,
  workspaces: ReadonlyArray<{ label: string; path: string }>,
): Promise<string[]> {
  try {
    const rows = await db
      .select({ toolInput: toolCalls.toolInput, toolOutput: toolCalls.toolOutput })
      .from(toolCalls)
      .where(
        and(
          eq(toolCalls.jobId, jobId),
          inArray(toolCalls.toolName, EDIT_TOOLS),
          gte(toolCalls.createdAt, since),
        ),
      );
    const author = workspaces.map((w) => ({ label: w.label, path: w.path }));
    const roots = workspaces.map((w) => w.path);
    const out = new Set<string>();
    for (const row of rows) {
      const p = scannedEditPath(row);
      if (!p) continue;
      // SANS le disque (revue Codex, passe 32) : un chemin relatif du harnais
      // est relatif à son `cwd`, qui est le PREMIER dossier attaché (voir
      // `cwd` plus bas) — et c'est le premier candidat que `resolveScannedPath`
      // rend quand aucun label ne tranche. Consulter l'existence, comme le fait
      // l'onglet Code, aurait perdu un fichier écrit puis supprimé dans le
      // même tour : une production réelle, jamais déclarée.
      const abs = resolveScannedPath(p, author, roots, () => true);
      if (abs) out.add(abs);
    }
    return [...out];
  } catch (err) {
    // Une panne de lecture ne doit pas tuer un tour déjà terminé. Elle est DITE
    // par un code, et on retombe sur « rien écrit » : ne pas rattacher est
    // réparable au tour suivant, rattacher à tort ne l'est pas (le registre
    // pose `project_id` une seule fois, le premier gagne).
    console.error(
      `[cli-runtime] CLI_WROTE_PROBE_FAILED job=${jobId} ` +
        `error=${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

export async function runCliRuntimeJob(args: {
  db: AnyDrizzleDb;
  jobId: string;
  job: CliRuntimeJobRow;
  agentRow: CliRuntimeAgentRow;
  workspaces: Array<{ label: string; path: string }>;
}): Promise<{ status: 'completed'; result: string } | { status: 'failed'; error: string }> {
  const { db, jobId, job, agentRow } = args;

  const fail = async (code: string): Promise<{ status: 'failed'; error: string }> => {
    await failJob(db, jobId, code);
    return { status: 'failed', error: code };
  };

  // Quel CLI sert ce runtime — voir provider.ts, l'unique tableau.
  const binding = resolveRuntime(agentRow.runtime);
  if (!binding) {
    return fail(`runtime_not_supported:${agentRow.runtime}`);
  }

  // LE FREIN D'URGENCE COUVRE AUSSI CE CHEMIN (revue P0 du 25/08, finding
  // majeur). Un agent à runtime CLI est dérouté vers ici bien AVANT l'étape
  // 8b du loop nodal, là où le frein retire les auto_approve : le bouton
  // rouge du workspace arrêtait donc les agents ordinaires pendant qu'une
  // session CLI — un shell complet dans le workspace — continuait de tourner.
  // Un frein qui ne freine qu'une partie des agents n'est pas un frein.
  if (job.entityId && (await isAutoRunPaused(db, job.entityId))) {
    return fail('auto_run_paused');
  }

  // The workspace IS the perimeter of a runtime agent — no workspace, no run.
  const cwd = args.workspaces[0]?.path;
  if (!cwd) {
    return fail('workspace_not_configured');
  }

  // Daily notional budget — same counter as code_task (cli_runs).
  try {
    await assertCliBudget(db, agentRow.id, binding.provider);
  } catch (err) {
    return fail(err instanceof Error ? err.message.slice(0, 300) : 'cli_daily_budget_exceeded');
  }

  // Session continuity: one CLI session per (agent, conversation).
  // assertRuntimeSessionKey: cli_sessions is shared with code_task, whose keys
  // carry a `code_task:` prefix, and the unique index is only
  // (agent_id, conversation_key). Checked rather than assumed — see the
  // helper for why the runtime side is NOT prefixed instead.
  const rawConversationKey = job.conversationId ?? job.chatId;
  const conversationKey = rawConversationKey
    ? assertRuntimeSessionKey(rawConversationKey)
    : rawConversationKey;
  let resumeSessionId: string | undefined;
  if (conversationKey) {
    const [existing] = await db
      .select({ sessionId: cliSessions.sessionId })
      .from(cliSessions)
      .where(
        and(
          eq(cliSessions.agentId, agentRow.id),
          eq(cliSessions.conversationKey, conversationKey),
          // Le FOURNISSEUR fait partie de l'identité d'une session (revue
          // Codex, 27/08). L'index unique ne porte que (agent, conversation) :
          // basculer un agent de Claude Code à Codex sur la même conversation
          // lui tendait l'identifiant de session de l'AUTRE CLI, que sa
          // commande de reprise refuse. Sans ce filtre, chaque tour repartait
          // en erreur de reprise après une bascule de runtime.
          eq(cliSessions.provider, binding.provider),
        ),
      )
      .limit(1);
    resumeSessionId = existing?.sessionId;
  }

  const perms = agentRow.cliPermissions ?? {};
  const mode: 'read' | 'write' = perms.mode ?? 'read';
  // Les défauts du fournisseur QUI TOURNE — pas ceux de Claude par principe.
  // Lire `cliDefaults.claude` en dur donnait à un agent Codex le modèle d'un
  // autre CLI, qui l'aurait refusé au lancement.
  const defaults = agentRow.cliDefaults?.[binding.provider] ?? {};

  // Live observability (vs dsh's thrown-away stream): each CLI-internal tool
  // event becomes a tool_calls row as it happens, so the existing Runs page
  // shows the session working in real time. Rows pair tool_use → tool_result
  // by the CLI's own tool_use id.
  const pending = new Map<string, { name: string; input: unknown; startedAt: number }>();
  // Les écritures d'audit ENCORE EN VOL à la fin du tour (revue Codex, passe
  // 33) : chaque insertion part sans être attendue — l'audit ne doit jamais
  // ralentir la CLI — mais `harnessEdits` les LIT juste après `binding.run`.
  // Le dernier événement d'un tour est précisément une écriture, et son
  // insertion pouvait être encore en route : chemins vides, projet jamais
  // déclaré. Elles sont donc gardées ici et attendues (jamais relancées, jamais
  // bloquantes pour le travail : `allSettled`) avant la lecture.
  const auditWrites: Promise<unknown>[] = [];
  const onEvent = (evt: ClaudeTurnEvent): void => {
    if (evt.kind === 'tool_use' && evt.toolUseId && evt.toolName) {
      pending.set(evt.toolUseId, {
        name: evt.toolName,
        input: evt.input,
        startedAt: Date.now(),
      });
      return;
    }
    if (evt.kind === 'tool_result' && evt.toolUseId) {
      const started = pending.get(evt.toolUseId);
      if (!started) return;
      pending.delete(evt.toolUseId);
      const write = db
        .insert(toolCalls)
        .values({
          entityId: job.entityId,
          jobId,
          // Le masquage et le préfixe vivent dans audit.ts, partagés avec le
          // chemin chat — voir ce fichier pour ce qui est masqué et pourquoi.
          ...buildCliAuditRow({
            toolName: started.name,
            toolInput: started.input,
            toolOutput: evt.output,
            toolCallId: evt.toolUseId,
            startedAt: started.startedAt,
            now: Date.now(),
          }),
        })
        .catch((err: unknown) => {
          console.warn(`[cli-runtime] tool_calls insert failed (job=${jobId}):`, err);
        });
      auditWrites.push(write);
    }
  };

  // Same single-write-slot contract as code_task: a write-mode CLI session
  // must not run concurrently with another write run (code_task or a second
  // runtime turn) in the same workspace — git index/deps state would race.
  //
  // TOUS les dossiers écrivables, pas seulement `cwd` — voir workspace-locks.ts.
  let locks: HeldLocks = { release: async () => {} };
  if (mode === 'write') {
    try {
      locks = await acquireWorkspaceLocks(
        db,
        args.workspaces.map((w) => w.path),
        jobId,
        agentRow.id,
      );
    } catch (err) {
      if (err instanceof WorkspaceLockedError) return fail(err.message.slice(0, 300));
      throw err;
    }
  }
  const releaseHeld = (): Promise<void> => locks.release();

  // The FULL Nodal prompt, not the raw personality field.
  //
  // This path used to pass `agentRow.personality` straight through, and it cost
  // the agent everything the orchestration layer assembles: the team block, so
  // an orchestrator with nine sub-agents attached in the database did not know
  // they existed; persistent memory; the skills; the workspace inventory; the
  // git posture. Reported live — "the sub-agents are ignored unless I paste
  // them into the system prompt myself" — and that was exactly right: pasting
  // them in was the only way they arrived.
  //
  // `surface: 'cli-runtime'` drops the ONE block that would be wrong here, the
  // built-in capability list: this agent's tools are the CLI's, not Nodal's.
  // La sonde git, que le chemin runtime ne transmettait PAS.
  //
  // La PR #7 a livre la conscience du depot, et la #8 a cable buildSystemPrompt
  // ici — sans jamais lui passer workspaceGit. Le bloc git n est rendu que si ce
  // champ existe, donc l agent qui en a le PLUS besoin, celui qui EST une CLI de
  // code, ne l a jamais eu. Trouve parce qu une banniere d interface affirmait
  // le contraire.
  //
  // Sonde le cwd reel de la session, pas le workspace partage : c est la que la
  // CLI travaille.
  //
  // Sous le MÊME filet que le tour lui-même (revue Codex, 27/08) : la sonde et
  // l'assemblage du prompt touchent le disque et la base. Une panne passagère
  // s'y produisait après la prise des verrous et avant le `try` — les dossiers,
  // le PARTAGÉ compris, restaient bloqués une demi-heure pour tout le monde,
  // jusqu'à la reprise du verrou périmé.
  //
  // ── L'intention de mutation — la CINQUIÈME surface, hors registre d'outils
  // (plan « Vérifier & Corriger », T17 / D8). Un runtime CLI écrit sans jamais
  // traverser executeTool : le seam unique des outils ne le voit pas, donc
  // l'intention se pose dans le try ci-dessous, entre la prise des verrous et
  // le spawn — le projet est sale AVANT que la CLI touche au disque. Même
  // prédicat que les verrous (mode write), même périmètre (TOUS les dossiers
  // attachés : `cwd` n'est que le premier, le reste part en extraWriteDirs).
  // Sous le même filet que l'assemblage du prompt : un refus relâche les
  // verrous. `failed` ET `already_terminal` interdisent le spawn — un job
  // annulé qui laisse partir une CLI n'est pas annulé. Levé avec un CODE :
  // run-job ne marque pas le job lui-même, l'appelant décide.
  let systemPrompt: string;
  try {
    if (mode === 'write') {
      const intent = await writeMutationIntent(
        { db, entityId: job.entityId ?? '', jobId, workspaces: args.workspaces },
        {
          surface: 'cliRuntime',
          // Un harnais de code travaille sur le PROJET (v7-A).
          targets: args.workspaces.map((w) => ({
            kind: 'dir' as const,
            path: w.path,
            deliverableType: 'code_project' as const,
          })),
        },
      );
      if (intent.kind === 'failed') {
        throw new Error(`verification_intent_failed:${intent.code}`);
      }
      if (intent.kind === 'already_terminal') {
        throw new Error('verification_intent_failed:intent_already_terminal');
      }
    }

    const workspaceGit = await probeWorkspaceGit(cwd);
    // Le fil et son projet courant (P6) — `null` pour un job hors conversation,
    // ou dont l'uuid date d'avant P6 et ne pointe aucune ligne.
    const conversation = job.conversationId
      ? await loadConversationContext(db, job.conversationId, {
          excludeJobId: jobId,
          task: job.task,
        })
      : null;
    systemPrompt = await buildSystemPrompt(
      agentRow,
      db,
      buildCliRuntimeJobContext({
        origin: job.channel ?? 'unknown',
        task: job.task,
        chatId: job.chatId,
        workspaceGit,
        workspaces: args.workspaces,
        ...(conversation ? { conversation } : {}),
      }),
    );
  } catch (err) {
    await releaseHeld();
    throw err;
  }

  // Keep the job alive under the 5-minute reaper for the whole CLI run.
  const heartbeat = setInterval(() => {
    void touchJob(db, jobId).catch(() => {});
  }, 60_000);

  // L'instant où le tour commence — borne basse pour reconnaître les écritures
  // que CE tour a produites (voir `harnessEdits` plus haut).
  const turnStartedAt = new Date();

  let turn: CliTurnResult;
  try {
    turn = await binding.run({
      message: job.task ?? '',
      personality: systemPrompt,
      cwd,
      // Les autres dossiers attachés — voir ClaudeTurnOptions.extraWriteDirs.
      extraWriteDirs: args.workspaces.slice(1).map((w) => w.path),
      mode,
      extraDisallowed: perms.extraDisallowed,
      model: defaults.model,
      effort: defaults.effort,
      resumeSessionId,
      timeoutMs: RUNTIME_TURN_TIMEOUT_MS,
      // The CLI runs its own internal loop the Nodal counters never see —
      // apply the SAME per-turn cap at this seam (invariant #8).
      maxToolCalls: DEFAULT_LIMITS.maxToolCallsPerTurn,
      onEvent,
    });
  } catch (err) {
    clearInterval(heartbeat);
    await releaseHeld();
    if (isCliSetupError(err)) return fail(err.message.slice(0, 300));
    throw err;
  }
  clearInterval(heartbeat);
  await releaseHeld();

  // Audit — one cli_runs row per turn, success or failure (the cost is real).
  try {
    await recordCliRun(db, {
      entityId: job.entityId,
      agentId: agentRow.id,
      jobId,
      provider: binding.provider,
      mode,
      source: 'subscription',
      sessionId: turn.sessionId,
      model: defaults.model ?? null,
      effort: defaults.effort ?? null,
      costUsd: turn.costUsd,
      inputTokens: turn.usage?.inputTokens ?? null,
      outputTokens: turn.usage?.outputTokens ?? null,
      cachedTokens: turn.usage?.cachedTokens ?? null,
      cacheCreationTokens: turn.usage?.cacheCreationTokens ?? null,
      modelUsage: turn.modelUsage,
      durationMs: turn.durationMs,
      cliVersion: null,
      exitCode: turn.exitCode,
    });
  } catch (err) {
    console.warn(`[cli-runtime] cli_runs audit insert failed (job=${jobId}):`, err);
  }

  // Persist the session mapping so the NEXT message on this conversation
  // resumes the same CLI session.
  if (conversationKey && turn.sessionId) {
    await db
      .insert(cliSessions)
      .values({
        entityId: job.entityId,
        agentId: agentRow.id,
        conversationKey,
        provider: binding.provider,
        sessionId: turn.sessionId,
      })
      .onConflictDoUpdate({
        target: [cliSessions.agentId, cliSessions.conversationKey],
        // `provider` est REPOSÉ, pas seulement l'identifiant : l'index unique ne
        // porte que (agent, conversation), donc après une bascule de runtime la
        // ligne gardait le nom de l'ancien CLI tout en portant la session du
        // nouveau. La ligne se serait contredite elle-même.
        set: { sessionId: turn.sessionId, provider: binding.provider, updatedAt: sql`now()` },
      })
      .catch((err: unknown) => {
        console.warn(`[cli-runtime] cli_sessions upsert failed (job=${jobId}):`, err);
      });
  }

  // ── Le REGISTRE des projets (P5), APRÈS le tour ───────────────────────────
  //
  // Sur les MÊMES cibles que l'intention (les dossiers attachés, le terrain
  // entier) : un harnais de code qui a travaillé dans un projet enregistré EST
  // une production dans ce projet, même sans traverser aucun outil. Posé après
  // `binding.run` et plus avant le spawn (revue Codex passe 27) : une CLI qui
  // n'a pas démarré n'a rien produit, et le registre ne doit pas dire le
  // contraire.
  //
  // MAIS un tour EN ERREUR peut avoir écrit (revue Codex passe 28) : une CLI
  // qui modifie dix fichiers puis sort en rouge parce que les tests échouent a
  // bel et bien produit dans ce projet. Le succès, lui, ne prouve rien non plus
  // — d'où la condition en deux branches. Le signal d'écriture est
  // `tool_calls` : les lignes de CE job, portant un outil d'édition, créées
  // depuis le début du tour. (`cli_runs.files_changed` n'existe pas — vérifié
  // dans le schéma, pas supposé.)
  //
  // Registre, pas garde — son issue n'interdit rien, et elle est posée AVANT le
  // retour d'erreur pour que le rattachement survive à ce retour.
  if (mode === 'write') {
    const turnSucceeded = !turn.isError && turn.finalText !== '';
    // Toutes les lignes d'audit du tour sont posées avant de les lire — voir
    // `auditWrites`. Une insertion qui a échoué est déjà journalisée ; elle ne
    // fait pas échouer le tour.
    await Promise.allSettled(auditWrites);
    const edits = await harnessEdits(db, jobId, turnStartedAt, args.workspaces);
    if (turnSucceeded || edits.length > 0) {
      await attachProductionToProject(
        {
          db,
          entityId: job.entityId ?? '',
          jobId,
          conversationId: job.conversationId ?? null,
          agentId: agentRow.id,
          workspaces: args.workspaces,
        },
        // Les FICHIERS écrits quand l'audit les connaît (P5b : c'est ainsi
        // qu'un enfant à manifeste du terrain se déclare), sinon les dossiers
        // attachés — un tour réussi sans ligne d'édition se RATTACHE à un
        // projet déjà déclaré, mais n'en déclare aucun (revue Codex, passe 32 :
        // seules les cibles fichier déclarent).
        edits.length > 0
          ? edits.map((path) => ({
              kind: 'file' as const,
              path,
              deliverableType: 'code_project' as const,
            }))
          : args.workspaces.map((w) => ({
              kind: 'dir' as const,
              path: w.path,
              deliverableType: 'code_project' as const,
            })),
      );
    }
  }

  if (turn.isError || turn.finalText === '') {
    // An exhausted subscription window must read as exactly that (D0/risques)
    // — as a machine CODE + data, never runner-authored prose (invariant #2:
    // the LLM speaks or the runner stays silent; error fields carry codes).
    const limitHit = turn.rateLimit && turn.rateLimit.status !== 'allowed';
    const code = limitHit
      ? `subscription_limit_reached` +
        (turn.rateLimit?.resetsAt
          ? ` resets_at=${new Date(turn.rateLimit.resetsAt * 1000).toISOString()}`
          : '') +
        (turn.errorDetail ? ` ${turn.errorDetail}` : '')
      : `cli_runtime_error: ${turn.errorDetail ?? 'no final text'}`;
    return fail(code.slice(0, 400));
  }

  // ── La porte terminale (V&C, T11) ─────────────────────────────────────────
  //
  // La cible de livraison est résolue AVANT la décision terminale et figée
  // avec elle : la ligne `job_deliveries` en `prepared` est commise DANS la
  // transaction qui pose le statut, puis le drain immédiat l'envoie — hors de
  // toute transaction, après que les verrous sont rendus. Un crash entre le
  // commit et l'envoi ne perd plus le message : le tick le reprend.
  //
  // Le texte du CLI part VERBATIM (invariant #2 : le LLM parle, Nodal relaie).
  // L'allowlist et les credentials se revérifient AU DRAIN, jamais ici.
  let delivery: { channel: string; chatId: string; payload: string } | undefined;
  if (job.chatId && turn.finalText.trim()) {
    const target = await resolveDeliveryTarget(db, {
      chatId: job.chatId,
      agentId: agentRow.id,
      channel: job.channel,
      triggerContext: job.triggerContext,
    });
    if (isDeliveryRefusal(target)) {
      console.error(`[cli-runtime] DELIVERY_TARGET_REFUSED job=${jobId} reason=${target.refused}`);
    } else {
      delivery = { channel: target.channel, chatId: target.chatId, payload: turn.finalText };
    }
  }

  const outcome = await finalizeJobSuccess(
    db,
    { jobId, result: turn.finalText, toolsUsed: [binding.toolLabel], delivery },
    {
      prepareDelivery: async (tx, input) => {
        await prepareDelivery(tx, {
          jobId: input.jobId,
          channel: input.channel as Parameters<typeof prepareDelivery>[1]['channel'],
          chatId: input.chatId,
          payload: input.payload,
        });
      },
    },
  );

  if (outcome.kind === 'already_terminal') {
    // Course perdue : un autre chemin a fini ce job pendant le tour. Rien n'a
    // été écrit, rien ne part — l'ancien code envoyait quand même.
    return { status: 'failed', error: 'already_handled' };
  }

  // Drain immédiat — la latence d'aujourd'hui (un envoi dans la seconde, pas
  // au prochain tick). Une panne ICI ne défait pas un job déjà commis : elle
  // est dite, et la ligne `prepared` sera reprise au tick.
  try {
    await drainDeliveries(db, { jobId });
  } catch (err) {
    console.error(
      `[cli-runtime] DELIVERY_DRAIN_FAILED job=${jobId} error=${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { status: 'completed', result: turn.finalText };
}
