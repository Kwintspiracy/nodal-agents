// team-block.ts — auto-generate the ## Your team prompt section from DB
// Invariant 1: ZERO hardcoded agent slugs/names/metadata in this file.
// Every agent name, slug, skill, instruction comes from DB at runtime.

import { eq, and } from '@nodal-agents/db';
import {
  agents,
  agentAssignments,
  agentSkillAssignments,
  agentSkills,
  agentConnectorAssignments,
  connectors as connectorsTable,
  agentMcpServers,
  mcpServers,
} from '@nodal-agents/db';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';
import { CLI_RUNTIME_RUNS_SHELL_COMMANDS, resolveRunWorkspaces } from '@nodal-agents/tools';
import { resolveBuiltinToolNames } from './builtin-tool-names';
import { modelCanSeeImages } from '@nodal-agents/shared';
import type { AgentId, AnyDrizzleDb } from './types';
import { detectOrchestratorMode } from './orchestrator-mode';
import { summarizePurpose } from './router/assign-tools';

// ─── buildTeamBlock ───────────────────────────────────────────────────────────

// No bound on the folders or programs an entry lists (Codex review of #506,
// pass 2): the roster is declared COMPLETE, and a "+N more" made the
// orchestrator treat the Nth folder as nobody's. The prompt cost of a long
// list was a P3; a false "cannot" is worse.

/**
 * Build the `## Your team` section for an orchestrator's system prompt.
 *
 * The content is generated entirely from DB state:
 * - Children come from agent_assignments JOIN agents (active only)
 * - Skills come from agent_skill_assignments JOIN agent_skills
 * - Instructions come from agent_assignments.instructions
 *
 * Returns '' if the agent has no active children (worker mode — no team block needed).
 *
 * @param parentAgentId  The orchestrator agent's ID
 * @param db             Drizzle DB handle
 */
export interface TeamBlockOptions {
  /**
   * Whether the agent can actually CALL a delegation tool.
   *
   * False on the `cli-runtime` surface, and it is not a nuance: a Claude Code
   * session is handed `--strict-mcp-config` and a purely SUBTRACTIVE
   * `--disallowedTools` (claude-turn.ts) — there is no `--allowedTools`, no
   * `--mcp-config`, no path by which `assign_x` becomes a dispatcher call. Its
   * tool_use events land in the audit table and stop there.
   *
   * So the roster still belongs in the prompt — an agent that does not know its
   * team is the bug this whole surface exists to fix — but the instructions do
   * not. Telling a model to call a tool it cannot reach produces either an
   * invented tool call or a refusal to proceed; both are worse than knowing the
   * team and saying so.
   */
  delegation?: boolean;
  /**
   * La surface `chat` : pas d'outil de délégation non plus, mais un chemin
   * pour faire faire le travail — `run_task` lance un job, et c'est ce job
   * qui délègue. Le roster reste une connaissance ; la phrase qui dit « il n'y
   * a aucun moyen de leur confier du travail » serait FAUSSE ici, et un agent
   * qui la croit répond « je ne peux pas » à une demande qu'il devait escalader.
   */
  escalation?: boolean;
}

export async function buildTeamBlock(
  parentAgentId: AgentId,
  db: AnyDrizzleDb,
  options: TeamBlockOptions = {},
): Promise<string> {
  const canDelegate = options.delegation !== false;
  // Load children from DB
  const childRows = await db
    .select({
      subAgentId: agentAssignments.subAgentId,
      instructions: agentAssignments.instructions,
      agentName: agents.name,
      agentSlug: agents.slug,
      agentRole: agents.role,
      agentActive: agents.active,
      agentPersonality: agents.personality,
      agentModel: agents.model,
      agentRuntime: agents.runtime,
      agentCommandAllowlist: agents.commandAllowlist,
    })
    .from(agentAssignments)
    .innerJoin(agents, eq(agentAssignments.subAgentId, agents.id))
    .where(
      and(eq(agentAssignments.orchestratorId, parentAgentId as string), eq(agents.active, true)),
    );

  if (childRows.length === 0) return '';

  // Detect mode: router (has sub-orchestrators) or planner (workers only)
  const parentRow = await db
    .select({
      role: agents.role,
      orchestratorMode: agents.orchestratorMode,
      entityId: agents.entityId,
    })
    .from(agents)
    .where(eq(agents.id, parentAgentId as string))
    .limit(1);

  const parent = parentRow[0];
  if (!parent) return '';

  const childrenForMode = childRows.map((r) => ({
    role: r.agentRole as 'agent' | 'orchestrator' | 'system',
  }));

  const mode = detectOrchestratorMode(
    {
      role: parent.role as 'agent' | 'orchestrator' | 'system',
      orchestratorMode: parent.orchestratorMode as 'router' | 'planner' | null,
    },
    childrenForMode,
  );

  // Load skill assignments for all children
  const childIds = childRows.map((r) => r.subAgentId);
  const skillRows = await Promise.all(
    childIds.map((id) =>
      db
        .select({
          agentId: agentSkillAssignments.agentId,
          skillName: agentSkills.name,
          skillSlug: agentSkills.slug,
          skillDescription: agentSkills.description,
        })
        .from(agentSkillAssignments)
        .innerJoin(agentSkills, eq(agentSkillAssignments.skillId, agentSkills.id))
        .where(eq(agentSkillAssignments.agentId, id as string)),
    ),
  );

  // Keep the NAME and the DESCRIPTION: the orchestrator routes by what a skill
  // DOES ("generate images via ComfyUI"), not by its opaque slug ("comfyui").
  // Names-only here is exactly why a router confabulated a fake image agent
  // instead of delegating to the teammate holding the ComfyUI skill.
  const skillMap = new Map<string, { name: string; desc: string | null }[]>();
  for (const batch of skillRows) {
    for (const r of batch) {
      const existing = skillMap.get(r.agentId) ?? [];
      existing.push({ name: r.skillName, desc: r.skillDescription });
      skillMap.set(r.agentId, existing);
    }
  }

  // Where each agent works (#506). Run 0b505b0d: the owner named a folder that
  // was inside Montage's own, and the orchestrator — seeing no folder for anyone
  // — invented `shared/Nodal-Video`. The list is EXACTLY the one that agent's
  // run receives, the workspace's shared folder included: the same function
  // builds both (`resolveRunWorkspaces`, tools). A first version read
  // `agent_workspaces` alone and said "Folders: none" of an agent that reads
  // and writes the shared folder (Codex review of #506, P1).
  const folderMap = new Map<string, string[]>();
  // Whether each agent's job whitelist carries `run_command` — the very
  // computation the runner makes (`resolveBuiltinToolNames`), orchestrators
  // included: their branch never adds skill-required builtins (Codex, P1).
  const runCommandMap = new Map<string, boolean>();
  await Promise.all(
    childRows.map(async (r) => {
      const { workspaces } = await resolveRunWorkspaces(db, r.subAgentId, parent.entityId);
      folderMap.set(
        r.subAgentId,
        workspaces.map((w) => `${w.label} = ${w.path}`),
      );
      const { names } = await resolveBuiltinToolNames(db, r.subAgentId);
      runCommandMap.set(r.subAgentId, names.includes('run_command'));
    }),
  );

  // Load connector tool inventories for all children — the orchestrator needs
  // to know what each sub-agent CAN do (not just its skills) so it routes the
  // user's request to the right one. Pre-this-change Conciergus answered
  // "I don't have Airtable access" directly when asked to list bases instead
  // of delegating to Summarizus (who had Airtable assigned).
  const connectorRows = await Promise.all(
    childIds.map((id) =>
      db
        .select({
          agentId: agentConnectorAssignments.agentId,
          slug: connectorsTable.slug,
          enabledOperations: agentConnectorAssignments.enabledOperations,
        })
        .from(agentConnectorAssignments)
        .innerJoin(connectorsTable, eq(connectorsTable.id, agentConnectorAssignments.connectorId))
        .where(eq(agentConnectorAssignments.agentId, id as string)),
    ),
  );

  // For each child: list of (slug, tool names enabled)
  const connectorMap = new Map<string, { slug: string; toolNames: string[] }[]>();
  for (const batch of connectorRows) {
    for (const r of batch) {
      const entry = ADAPTER_REGISTRY[r.slug];
      if (!entry) continue; // catalog entry without adapter — invisible to orchestrator too
      const allToolNames = entry.operations.map((o) => o.slug);
      const toolNames =
        r.enabledOperations === null
          ? allToolNames
          : allToolNames.filter((n) => r.enabledOperations!.includes(n));
      if (toolNames.length === 0) continue;
      const existing = connectorMap.get(r.agentId) ?? [];
      existing.push({ slug: r.slug, toolNames });
      connectorMap.set(r.agentId, existing);
    }
  }

  // Load MCP server inventories — same rationale as connectors. MCP servers
  // are a separate code path from connectors, so without this loop the
  // orchestrator has zero info about its children's MCP capabilities.
  // Empirically observed (2026-05-26): a router orchestrator refused 6× to
  // delegate a payments-API request to a child that had the matching MCP
  // server attached, because the MCP inventory was invisible here.
  const mcpRows = await Promise.all(
    childIds.map((id) =>
      db
        .select({
          agentId: agentMcpServers.agentId,
          serverSlug: mcpServers.slug,
          enabledTools: agentMcpServers.enabledTools,
          availableTools: mcpServers.availableTools,
          serverActive: mcpServers.active,
        })
        .from(agentMcpServers)
        .innerJoin(mcpServers, eq(mcpServers.id, agentMcpServers.mcpServerId))
        .where(eq(agentMcpServers.agentId, id as string)),
    ),
  );

  // For each child: list of (server-slug, namespaced tool names enabled).
  // Tool names match the runtime convention `<sanitized-slug>__<original-name>`
  // (see packages/adapters/mcp/src/tools.ts) so the orchestrator sees the
  // exact tool identifier the child agent has at runtime.
  const mcpMap = new Map<string, { slug: string; toolNames: string[] }[]>();
  for (const batch of mcpRows) {
    for (const r of batch) {
      if (r.serverActive === false) continue;
      const prefix = r.serverSlug.replace(/-/g, '_');
      const available = Array.isArray(r.availableTools)
        ? (r.availableTools as Array<{ name?: unknown }>)
            .map((t) => (t && typeof t.name === 'string' ? t.name : null))
            .filter((n): n is string => n !== null)
        : [];
      if (available.length === 0) continue;
      const enabled = Array.isArray(r.enabledTools)
        ? new Set((r.enabledTools as unknown[]).filter((n): n is string => typeof n === 'string'))
        : null;
      const kept = enabled === null ? available : available.filter((n) => enabled.has(n));
      if (kept.length === 0) continue;
      const toolNames = kept.map((n) => `${prefix}__${n}`);
      const existing = mcpMap.get(r.agentId) ?? [];
      existing.push({ slug: r.serverSlug, toolNames });
      mcpMap.set(r.agentId, existing);
    }
  }

  // Capability hint = the connector/MCP NAMES the child can use (not the full
  // per-operation list, which was noise the orchestrator couldn't route on). The
  // name conveys the capability so the orchestrator won't think the child lacks
  // an integration.
  function formatConnectorsTag(subAgentId: string): string {
    const conn = connectorMap.get(subAgentId);
    const mcp = mcpMap.get(subAgentId);
    const names: string[] = [];
    if (conn) names.push(...conn.map((c) => c.slug));
    if (mcp) names.push(...mcp.map((c) => c.slug));
    if (names.length === 0) return '';
    return `\n  Connectors: ${[...new Set(names)].join(', ')}`;
  }

  // Whether the agent can run a shell command (#506), from the database and
  // the same way for every agent. On the Nodal runtime it is the `run_command`
  // tool, unlocked by a skill and narrowed by `command_allowlist` (an EMPTY
  // list refuses everything). On a CLI runtime that tool does not exist: the
  // CLI's own posture decides, which `CLI_RUNTIME_RUNS_SHELL_COMMANDS` states
  // next to the argv that produces it. Run 8dfe4684 sent a render to an agent
  // on the claude-code runtime, which refuses every command.
  function formatShellTag(
    subAgentId: string,
    runtime: string,
    allowlist: readonly string[] | null,
  ): string {
    let canRun: boolean;
    if (runtime === 'nodal') {
      canRun = (runCommandMap.get(subAgentId) ?? false) && allowlist?.length !== 0;
    } else {
      const cli = CLI_RUNTIME_RUNS_SHELL_COMMANDS[runtime];
      // The DB check constraint admits no other value; a newer base that
      // does must be taught here, never guessed (invariant #4).
      if (cli === undefined) {
        throw new Error(`buildTeamBlock: unknown agent runtime "${runtime}" for ${subAgentId}`);
      }
      canRun = cli;
    }
    if (!canRun) return '\n  Shell commands: no';
    if (runtime === 'nodal' && allowlist && allowlist.length > 0) {
      return `\n  Shell commands: yes, only these programs: ${allowlist.join(', ')}`;
    }
    return '\n  Shell commands: yes';
  }

  // Unified orchestrator: every orchestrator receives BOTH delegation toolsets at
  // runtime (assign_* for in-line/sequential delegation, create_task for parallel
  // fan-out — see apps/runner/src/job/execute.ts tool selection). So the prompt
  // presents BOTH styles and lets the model pick per request, rather than a hard
  // router/planner XOR. `mode` (auto-detected from child roles, or pinned by the
  // operator) is surfaced only as a soft default lean — never as an exclusive
  // instruction. The runtime enforces "one style per job": once create_task has
  // run, the assign_* path defers (execute.ts commit guard), so the two completion
  // models never collide on the same job.
  const defaultLean =
    mode === 'router'
      ? 'Default lean: this team includes sub-orchestrators, so in-line `assign_*` ' +
        'delegation is usually the right call — reach for `create_task` only when you ' +
        'have genuinely independent work to run in parallel.'
      : 'Default lean: this team is independent workers, so `create_task` parallel ' +
        'fan-out is usually the right call for multi-part work — use `assign_*` when a ' +
        'single agent can handle the whole request or when steps depend on each other.';

  // Build lines array (all data from DB — no hardcoded names)
  const lines: string[] = [];
  lines.push('## Your team\n');
  if (!canDelegate && options.escalation === true) {
    // Roster as a FACT, plus the one path that gets work done from here.
    lines.push(
      'These agents exist in this workspace and are attached to you. In this chat you have ' +
        'NO delegation tool — the job you start with `run_task` is where delegation happens, ' +
        'and it will see this same team. Treat the list as knowledge (who exists, what each is ' +
        'for) when you write the `run_task` instruction; never pretend to delegate from here.\n',
    );
  } else if (!canDelegate) {
    // Roster as a FACT, not a manual. See TeamBlockOptions.delegation.
    lines.push(
      'These agents exist in this workspace and are attached to you. On THIS surface you ' +
        'have NO delegation tool: there is no way for you to hand work to them, and any ' +
        'attempt to call one would reach nothing. Treat the list as knowledge — who exists, ' +
        'what each is for — and if a request genuinely needs one of them, say so plainly ' +
        'rather than pretend to delegate.\n',
    );
  } else {
    lines.push(
      'You orchestrate the agents below. You have TWO ways to delegate — choose the one ' +
        'that fits the request:\n',
    );
    lines.push(
      '- **`assign_<agent>` — one delegation, in-line.** Hand the request (or a single ' +
        'step of it) to ONE agent and get its result back before continuing. Use this for a ' +
        'single delegation, or when the next step depends on this one’s result (reactive / ' +
        'sequential work). Only one assignment per turn; after the agent returns, either ' +
        'finish with `return_result` or assign the next step. Do NOT delegate again unless ' +
        'the request needs another step. What comes back is a typed record — `status`, ' +
        '`summary`, `error` — where `summary` is the agent’s own final reply. A `status` ' +
        'other than `completed` means that delegation delivered NOTHING: do the work ' +
        'yourself, hand it to a different agent, or tell the user what failed — never ' +
        'announce that the work is under way, because it is not.',
    );
    lines.push(
      '- **`create_task` — parallel fan-out.** Create several INDEPENDENT tasks at once, ' +
        'each `assigned_to` an agent by its handle. They run concurrently in the background ' +
        'and their results are compiled and delivered automatically once all finish. Use ' +
        'this when the pieces of work do not depend on each other and can run in parallel. ' +
        'Use `depends_on` to order tasks that must run in sequence within the board. After ' +
        'creating the tasks, end your turn with a brief `return_result` acknowledgment — the ' +
        'task board runs them, so do NOT call `list_tasks` to wait (only use it to fetch a ' +
        'task ID for a `depends_on` reference).\n',
    );
    lines.push(
      '⚠️ THE FINAL SUMMARY TO THE USER IS AUTOMATIC — NEVER MAKE IT A TASK. Once the work tasks ' +
        'finish, the system composes a short summary of the whole run and sends it to the user on ' +
        'their original channel by itself. So even when the user says "puis fais une synthèse et ' +
        'envoie-la moi" / "then summarize and send it to me", that final summarize-and-send step is ' +
        'ALREADY handled — do NOT turn it into a task and do NOT add a `depends_on` "synthèse"/' +
        '"summary"/"→ Telegram" task. Creating one produces a DUPLICATE and an extra useless run. ' +
        'Create ONLY the real work tasks, then `return_result`. If the user wants a long deliverable ' +
        '(a file, an Obsidian note, an email, an HTML page), make a work task that PRODUCES that ' +
        'artifact — but the chat reply itself is never a task.\n',
    );
    lines.push(
      'Pick ONE style per request — do not mix them in the same job. ' + defaultLean + '\n',
    );
    // Une règle « ne dicte pas de chemin en déléguant » a vécu ici quelques
    // heures le 26/08. Retirée : c'est une INSTRUCTION D'AGENT, pas une loi du
    // harnais (invariant #3 — « fix at agent layer, never patch the runtime »).
    //
    // Elle s'imposait à tous les orchestrateurs de toutes les installs pour un
    // besoin qui appartient à un espace de travail précis. Le harnais dit ce
    // qui EST — voici tes agents, voici tes outils. Ce qu'on en fait relève de
    // la personnalité, qui vit en base et se corrige en une minute sans revue
    // de code.
    //
    // Ce que le harnais devait vraiment corriger, il l'a été ailleurs : le bloc
    // `## Workspaces` annonçait UN dossier là où les outils en avaient DEUX.
    // C'était un fait faux, donc un bug ; la destination d'un livrable est un
    // comportement, donc une consigne.
  }
  lines.push('Your agents:');
  for (const row of childRows) {
    const {
      subAgentId,
      agentName,
      agentSlug,
      agentRole,
      instructions,
      agentPersonality,
      agentModel,
      agentRuntime,
      agentCommandAllowlist,
    } = row;
    const toolSlug = agentSlug.replace(/-/g, '_');
    // What the agent is FOR (summary of its personality) — drives correct routing.
    const purpose = summarizePurpose(agentPersonality);
    const purposeTag = purpose ? `\n  Purpose: ${purpose}` : '';
    // Surface the agent's LLM vision capability so the orchestrator can route an
    // image to a teammate that can actually SEE it (the image travels with the
    // delegation). Only shown when true — a positive capability the model routes on.
    const visionTag = modelCanSeeImages(agentModel ?? '')
      ? '\n  LLM: can see images (vision) — route image tasks here'
      : '';
    const skills = skillMap.get(subAgentId) ?? [];
    const skillsTag =
      skills.length > 0
        ? `\n  Skills (what it can do): ${skills
            .map((s) => {
              const d = s.desc ? s.desc.replace(/\s+/g, ' ').trim() : '';
              const short = d.length > 140 ? `${d.slice(0, 139).trimEnd()}…` : d;
              return short ? `${s.name} — ${short}` : s.name;
            })
            .join('; ')}`
        : '';
    const connectorsTag = formatConnectorsTag(subAgentId);
    const folders = folderMap.get(subAgentId);
    const foldersTag = `\n  Folders: ${folders && folders.length > 0 ? folders.join('; ') : 'none'}`;
    const runtimeTag = `\n  Runtime: ${agentRuntime}`;
    const shellTag = formatShellTag(subAgentId, agentRuntime, agentCommandAllowlist);
    const capabilityTags = `${connectorsTag}${foldersTag}${runtimeTag}${shellTag}`;
    const roleTag = agentRole === 'orchestrator' ? ' (orchestrator)' : '';
    const instrTag = instructions ? `\n  Instructions: ${instructions}` : '';
    lines.push(
      canDelegate
        ? `- **${agentName}**${roleTag} — assign tool \`assign_${toolSlug}\`, task handle ` +
            `\`${agentSlug}\`${purposeTag}${visionTag}${skillsTag}${capabilityTags}${instrTag}`
        : // No tool name: naming `assign_x` to an agent that cannot call it is
          // precisely what turned this roster into an invitation to hallucinate.
          `- **${agentName}**${roleTag} (\`${agentSlug}\`)` +
            `${purposeTag}${visionTag}${skillsTag}${capabilityTags}${instrTag}`,
    );
  }

  lines.push(
    '\n⚠️ The roster above is the COMPLETE, GROUND-TRUTH list of your team and their ' +
      'capabilities. ONLY ever reference agents, skills, connectors, tools, or folders that ' +
      'appear above — NEVER invent a teammate, a capability, or a path. When the user names a ' +
      'folder, find it among the Folders listed; if no agent has it, say so. A request that ' +
      'needs a shell command goes only to an agent whose Shell commands is yes. Before saying you cannot do ' +
      'something, scan the list: if any agent’s skills/connectors match the request, delegate ' +
      'to it. If genuinely none match, say so plainly (and how the user could enable it, if ' +
      'you know) — do NOT fabricate an agent name or claim a tool you were not given.',
  );

  return lines.join('\n');
}
