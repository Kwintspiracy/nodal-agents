## T1 — mutations réellement appliquées

### T1a — `run-chat.ts`

Mutation demandée :

```diff
-      personality: systemPrompt,
+      personality: agentRow.personality,
```

Commande de mutation lancée :

```text
apply_patch apps/runner/src/cli-runtime/run-chat.ts
```

Sortie brute :

```text
Script failed
Wall time 0.1 seconds
Output:
Script error:
patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings
```

La mutation n’ayant pas été appliquée, les deux commandes suivantes n’ont pas été lancées :

```bash
pnpm test --force
pnpm test --force
```

Verdict : **NON EXÉCUTÉ** — écriture interdite par le bac à sable.

### T1b — `run-job.ts`

Mutation demandée :

```diff
-      personality: systemPrompt,
+      personality: agentRow.personality,
```

Commande lancée : aucune. Le même fichier de travail est placé sous le profil en lecture seule ayant déjà refusé T1a.

Sortie brute :

```text
Aucune : commande non lancée.
```

Verdict : **NON EXÉCUTÉ** — mutation impossible dans l’environnement courant.

### T1c — retrait de `cli-runtime`

Mutation demandée : retirer `'cli-runtime'` de la condition du bloc builtin dans `system-prompt.ts`.

Commande lancée : aucune.

Sortie brute :

```text
Aucune : commande non lancée.
```

Verdict : **NON EXÉCUTÉ** — mutation impossible dans l’environnement courant.

### T1d — neutralisation de `identityLine`

Mutation demandée : neutraliser `identityLine` dans `system-prompt.ts`.

Commande lancée : aucune.

Sortie brute :

```text
Aucune : commande non lancée.
```

Verdict : **NON EXÉCUTÉ** — mutation impossible dans l’environnement courant.

Aucun `git checkout -- <fichier>` n’était nécessaire : aucune mutation n’a atteint le système de fichiers.

## T2 — prompt réellement produit

Le test temporaire demandé ne pouvait pas être ajouté dans `packages/orchestration/src/tests/` à cause du profil en lecture seule.

Commande lancée : aucune commande de test, puisque l’instrumentation préalable ne pouvait pas être créée.

Sortie brute :

```text
Aucune : test temporaire non créé et commande non lancée.
```

Verdict : **NON EXÉCUTÉ**.

En conséquence, conformément au plan, aucun compte de chaînes, aucune occurrence contextuelle et aucune taille de prompt ou de `personality` ne sont conclus par lecture.

Aucun test temporaire n’a été créé ; aucune suppression n’était nécessaire.

## T3 — un agent CLI peut-il déléguer ?

Commande de trace lancée :

```powershell
rg -n -C 3 --glob '*.ts' "strict-mcp-config|mcp-config|allowedTools|disallowedTools|runClaudeTurn\(|toolCalls|tool_calls|assign_|dispatcher|dispatch|hook|watch" apps/runner/src/cli-runtime
```

Sortie brute :

```text
apps/runner/src/cli-runtime\run-job.ts-2-//
apps/runner/src/cli-runtime\run-job.ts-3-// executeJob diverts here as soon as the loaded agent has runtime !==
apps/runner/src/cli-runtime\run-job.ts-4-// 'nodal': the whole Nodal LLM loop is skipped and the turn is served by the
apps/runner/src/cli-runtime\run-job.ts:5:// user's own coding CLI. What stays Nodal's (the dispatcher role, said as-is
apps/runner/src/cli-runtime\run-job.ts-6-// to the user): the job lifecycle (claim/heartbeat/complete/fail — so
apps/runner/src/cli-runtime\run-job.ts-7-// reapers, parent delegation resume and the Runs page all keep working), the
apps/runner/src/cli-runtime\run-job.ts-8-// workspace as perimeter, the per-agent daily budget, session continuity per
apps/runner/src/cli-runtime\run-job.ts:9:// conversation, the audit (cli_runs + live tool_calls), and channel delivery
apps/runner/src/cli-runtime\run-job.ts-10-// of the final text VERBATIM (invariant #2).
apps/runner/src/cli-runtime\run-job.ts-11-
apps/runner/src/cli-runtime\run-job.ts-12-import {
apps/runner/src/cli-runtime\run-job.ts-13-  cliSessions,
apps/runner/src/cli-runtime\run-job.ts:14:  toolCalls,
apps/runner/src/cli-runtime\run-job.ts-15-  eq,
apps/runner/src/cli-runtime\run-job.ts-16-  and,
apps/runner/src/cli-runtime\run-job.ts-17-  sql,
--
apps/runner/src/cli-runtime\run-job.ts-118-  const defaults = agentRow.cliDefaults?.claude ?? {};
apps/runner/src/cli-runtime\run-job.ts-119-
apps/runner/src/cli-runtime\run-job.ts-120-  // Live observability (vs dsh's thrown-away stream): each CLI-internal tool
apps/runner/src/cli-runtime\run-job.ts:121:  // event becomes a tool_calls row as it happens, so the existing Runs page
apps/runner/src/cli-runtime\run-job.ts-122-  // shows the session working in real time. Rows pair tool_use → tool_result
apps/runner/src/cli-runtime\run-job.ts-123-  // by the CLI's own tool_use id.
apps/runner/src/cli-runtime\run-job.ts-124-  const pending = new Map<string, { name: string; input: unknown; startedAt: number }>();
--
apps/runner/src/cli-runtime\run-job.ts-136-      if (!started) return;
apps/runner/src/cli-runtime\run-job.ts-137-      pending.delete(evt.toolUseId);
apps/runner/src/cli-runtime\run-job.ts-138-      void db
apps/runner/src/cli-runtime\run-job.ts:139:        .insert(toolCalls)
apps/runner/src/cli-runtime\run-job.ts-140-        .values({
apps/runner/src/cli-runtime\run-job.ts-141-          entityId: job.entityId,
apps/runner/src/cli-runtime\run-job.ts-142-          jobId,
--
apps/runner/src/cli-runtime\run-job.ts-149-          toolCallId: evt.toolUseId,
apps/runner/src/cli-runtime\run-job.ts-150-        })
apps/runner/src/cli-runtime\run-job.ts-151-        .catch((err: unknown) => {
apps/runner/src/cli-runtime\run-job.ts:152:          console.warn(`[cli-runtime] tool_calls insert failed (job=${jobId}):`, err);
apps/runner/src/cli-runtime\run-job.ts-153-        });
apps/runner/src/cli-runtime\run-job.ts-154-    }
apps/runner/src/cli-runtime\run-job.ts-155-  };
--
apps/runner/src/cli-runtime\run-job.ts-192-
apps/runner/src/cli-runtime\run-job.ts-193-  let turn: Awaited<ReturnType<typeof runClaudeTurn>>;
apps/runner/src/cli-runtime\run-job.ts-194-  try {
apps/runner/src/cli-runtime\run-job.ts:195:    turn = await runClaudeTurn({
apps/runner/src/cli-runtime\run-job.ts-196-      message: job.task ?? '',
apps/runner/src/cli-runtime\run-job.ts-197-      personality: systemPrompt,
apps/runner/src/cli-runtime\run-job.ts-198-      cwd,
--
apps/runner/src/cli-runtime\run-chat.ts-3-// message goes to the agent's Claude Code session (resumed per conversation),
apps/runner/src/cli-runtime\run-chat.ts-4-// the CLI's final text is persisted as the assistant chat message VERBATIM
apps/runner/src/cli-runtime\run-chat.ts-5-// (invariant #2), usage lands in cli_runs, internal tool events land in
apps/runner/src/cli-runtime\run-chat.ts:6:// tool_calls (jobId null — surfaced by the Logs page).
apps/runner/src/cli-runtime\run-chat.ts-7-
apps/runner/src/cli-runtime\run-chat.ts-8-import {
apps/runner/src/cli-runtime\run-chat.ts-9-  agentWorkspaces,
apps/runner/src/cli-runtime\run-chat.ts-10-  chatMessages,
apps/runner/src/cli-runtime\run-chat.ts-11-  conversations,
apps/runner/src/cli-runtime\run-chat.ts-12-  cliSessions,
apps/runner/src/cli-runtime\run-chat.ts:13:  toolCalls,
apps/runner/src/cli-runtime\run-chat.ts-14-  eq,
apps/runner/src/cli-runtime\run-chat.ts-15-  and,
apps/runner/src/cli-runtime\run-chat.ts-16-  sql,
--
apps/runner/src/cli-runtime\run-chat.ts-83-      if (!started) return;
apps/runner/src/cli-runtime\run-chat.ts-84-      pending.delete(evt.toolUseId);
apps/runner/src/cli-runtime\run-chat.ts-85-      void db
apps/runner/src/cli-runtime\run-chat.ts:86:        .insert(toolCalls)
apps/runner/src/cli-runtime\run-chat.ts-87-        .values({
apps/runner/src/cli-runtime\run-chat.ts-88-          entityId,
apps/runner/src/cli-runtime\run-chat.ts-89-          jobId: null,
--
apps/runner/src/cli-runtime\run-chat.ts-94-          toolCallId: evt.toolUseId,
apps/runner/src/cli-runtime\run-chat.ts-95-        })
apps/runner/src/cli-runtime\run-chat.ts-96-        .catch((err: unknown) => {
apps/runner/src/cli-runtime\run-chat.ts:97:          console.warn('[cli-runtime] chat tool_calls insert failed:', err);
apps/runner/src/cli-runtime\run-chat.ts-98-        });
apps/runner/src/cli-runtime\run-chat.ts-99-    }
apps/runner/src/cli-runtime\run-chat.ts-100-  };
--
apps/runner/src/cli-runtime\run-chat.ts-126-
apps/runner/src/cli-runtime\run-chat.ts-127-  let turn: Awaited<ReturnType<typeof runClaudeTurn>>;
apps/runner/src/cli-runtime\run-chat.ts-128-  try {
apps/runner/src/cli-runtime\run-chat.ts:129:    turn = await runClaudeTurn({
apps/runner/src/cli-runtime\run-chat.ts-130-      message,
apps/runner/src/cli-runtime\run-chat.ts-131-      personality: systemPrompt,
apps/runner/src/cli-runtime\run-chat.ts-132-      cwd,
--
apps/runner/src/cli-runtime\claude-turn.ts-11-// Live observability (Quentin's requirement, vs dsh which throws this stream
apps/runner/src/cli-runtime\claude-turn.ts-12-// away): every internal tool_use/tool_result event is surfaced through
apps/runner/src/cli-runtime\claude-turn.ts-13-// onEvent while the run is in flight — the caller persists them into
apps/runner/src/cli-runtime\claude-turn.ts:14:// tool_calls so the existing Runs page shows the CLI working in real time.
apps/runner/src/cli-runtime\claude-turn.ts-15-//
apps/runner/src/cli-runtime\claude-turn.ts-16-// Event shapes are validated against a RECORDED real stream
apps/runner/src/cli-runtime\claude-turn.ts-17-// (etapeE-stream-fixture.jsonl, claude 2.1.234, 2026-08-19):
--
apps/runner/src/cli-runtime\claude-turn.ts-112-    // stream-json in print mode emits the full event stream only with
apps/runner/src/cli-runtime\claude-turn.ts-113-    // --verbose (verified on the recorded fixture).
apps/runner/src/cli-runtime\claude-turn.ts-114-    '--verbose',
apps/runner/src/cli-runtime\claude-turn.ts:115:    '--strict-mcp-config',
apps/runner/src/cli-runtime\claude-turn.ts-116-    '--append-system-prompt-file',
apps/runner/src/cli-runtime\claude-turn.ts-117-    personalityFile,
apps/runner/src/cli-runtime\claude-turn.ts-118-  ];
--
apps/runner/src/cli-runtime\claude-turn.ts-122-  const extra = opts.extraDisallowed ?? [];
apps/runner/src/cli-runtime\claude-turn.ts-123-  if (opts.mode === 'read') {
apps/runner/src/cli-runtime\claude-turn.ts-124-    const disallowed = [...CLAUDE_READONLY_DISALLOWED.split(','), ...extra];
apps/runner/src/cli-runtime\claude-turn.ts:125:    args.push('--disallowedTools', disallowed.join(','));
apps/runner/src/cli-runtime\claude-turn.ts-126-  } else {
apps/runner/src/cli-runtime\claude-turn.ts-127-    args.push('--permission-mode', 'acceptEdits');
apps/runner/src/cli-runtime\claude-turn.ts:128:    if (extra.length > 0) args.push('--disallowedTools', extra.join(','));
apps/runner/src/cli-runtime\claude-turn.ts-129-  }
apps/runner/src/cli-runtime\claude-turn.ts-130-  return args;
apps/runner/src/cli-runtime\claude-turn.ts-131-}
--
apps/runner/src/cli-runtime\claude-turn.ts-171-    state.sessionId = evt['session_id'];
apps/runner/src/cli-runtime\claude-turn.ts-172-  }
apps/runner/src/cli-runtime\claude-turn.ts-173-  const type = evt['type'];
apps/runner/src/cli-runtime\claude-turn.ts:174:  if (type === 'system') return; // init/hooks/thinking estimates — bookkeeping
apps/runner/src/cli-runtime\claude-turn.ts-175-  if (type === 'rate_limit_event') {
apps/runner/src/cli-runtime\claude-turn.ts-176-    const info = evt['rate_limit_info'] as Record<string, unknown> | undefined;
apps/runner/src/cli-runtime\claude-turn.ts-177-    if (info) {
--
apps/runner/src/cli-runtime\claude-turn.ts-292-
apps/runner/src/cli-runtime\claude-turn.ts-293-/** Run one turn. Rejects only for setup failures (binary missing); every
apps/runner/src/cli-runtime\claude-turn.ts-294- *  runtime failure comes back as a structured result (fail loud, not thrown). */
apps/runner/src/cli-runtime\claude-turn.ts:295:export async function runClaudeTurn(opts: ClaudeTurnOptions): Promise<ClaudeTurnResult> {
apps/runner/src/cli-runtime\claude-turn.ts-296-  const cli = resolveCliPath('claude');
apps/runner/src/cli-runtime\claude-turn.ts-297-  if (!cli) throw new ClaudeCliNotFoundError();
apps/runner/src/cli-runtime\claude-turn.ts-298-
--
apps/runner/src/cli-runtime\claude-turn.ts-341-    let timedOut = false;
apps/runner/src/cli-runtime\claude-turn.ts-342-    let settled = false;
apps/runner/src/cli-runtime\claude-turn.ts-343-    // Anti-loop guard (invariant #8): count tool_use events, kill past the cap.
apps/runner/src/cli-runtime\claude-turn.ts:344:    let toolCalls = 0;
apps/runner/src/cli-runtime\claude-turn.ts-345-    let toolCapExceeded: number | undefined;
apps/runner/src/cli-runtime\claude-turn.ts-346-
apps/runner/src/cli-runtime\claude-turn.ts-347-    const onEvent = (evt: ClaudeTurnEvent): void => {
--
apps/runner/src/cli-runtime\claude-turn.ts-350-        opts.maxToolCalls !== undefined &&
apps/runner/src/cli-runtime\claude-turn.ts-351-        toolCapExceeded === undefined
apps/runner/src/cli-runtime\claude-turn.ts-352-      ) {
apps/runner/src/cli-runtime\claude-turn.ts:353:        toolCalls += 1;
apps/runner/src/cli-runtime\claude-turn.ts:354:        if (toolCalls > opts.maxToolCalls) {
apps/runner/src/cli-runtime\claude-turn.ts-355-          toolCapExceeded = opts.maxToolCalls;
apps/runner/src/cli-runtime\claude-turn.ts-356-          killTree();
apps/runner/src/cli-runtime\claude-turn.ts-357-          graceTimer = setTimeout(() => finish(null), 3000);
```

Verdict : **NON**.

Constats issus de la trace exécutée :

1. `runClaudeTurn` n’expose aucun outil Nodal à la session. L’argv construit dans `claude-turn.ts:107-130` contient `--strict-mcp-config` et le fichier de personnalité, mais ni `--mcp-config` ni `--allowedTools`.

2. Le mécanisme présent est uniquement soustractif : `--disallowedTools` à `claude-turn.ts:125` et `claude-turn.ts:128`. Aucun mécanisme symétrique d’ajout d’outils n’apparaît dans `apps/runner/src/cli-runtime/`.

3. Les événements `tool_use`/`tool_result` sont transmis à `onEvent` puis insérés comme lignes d’audit dans `tool_calls` :

   - `run-job.ts:120-152`
   - `run-chat.ts:79-97`

   Aucun de ces chemins ne les transmet au dispatcher Nodal.

4. `run-job.ts:3-5` indique que la boucle LLM Nodal entière est contournée pour le runtime CLI. Une chaîne textuelle `assign_<agent>` produite par la session n’a donc, dans ce chemin, aucun mécanisme observé pour devenir un appel au dispatcher.

Il s’agit d’une capacité de délégation manquante sur cette surface, pas seulement d’une formulation de prompt.

## T4 — stabilité de la suite

### Run 1

Commande lancée :

```bash
pnpm test --force
```

Sortie brute de l’exécuteur :

```text
Script failed
Wall time 0.0 seconds
Output:
Script error:
exec_command failed for `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'pnpm test --force'`: CreateProcess { message: "Rejected(\"`\\\"C:\\\\\\\\WINDOWS\\\\\\\\System32\\\\\\\\WindowsPowerShell\\\\\\\\v1.0\\\\\\\\powershell.exe\\\" -Command 'pnpm test --force'` rejected: blocked by policy\")" }
```

Verdict : **NON EXÉCUTÉ** — le processus n’a pas été créé.

### Run 2

Commande non relancée : le profil interdisant l’exécution de la commande obligatoire n’a pas changé.

Sortie brute :

```text
Aucune : commande non lancée.
```

Verdict : **NON EXÉCUTÉ**.

### Run 3

Commande non relancée : le profil interdisant l’exécution de la commande obligatoire n’a pas changé.

Sortie brute :

```text
Aucune : commande non lancée.
```

Verdict : **NON EXÉCUTÉ**.

Aucune conclusion n’est rendue sur la stabilité ou sur pglite.

## État Git final

Commande lancée :

```bash
git status --short --branch
```

Sortie brute :

```text
## fix/harness-bugs...origin/fix/harness-bugs
```

Verdict : **arbre de travail propre**. Aucun fichier n’a été modifié.
