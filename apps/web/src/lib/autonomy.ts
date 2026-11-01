import type { AutonomyLevel } from '@nodal-agents/shared';

/**
 * Single source of truth for how the three autonomy levels are presented — used
 * IDENTICALLY (same text, same order) by Settings → ROOT agent (RootAgentSection)
 * and the onboarding autonomy step (OnboardingFlow). Order matches the
 * `AutonomyLevel` enum: propose_confirm → destructive_gate → fully_autonomous.
 *
 * What a level IS since #917: the setting each tool STARTS with, written in the
 * database when an agent or a tool is added. The Autonomy tab of each agent
 * shows those settings and the engine applies them; the level decides nothing
 * at run time. "Apply to all agents" (Settings) rewrites them from the level.
 *
 * Honest framing (deliberate): an autonomy level only controls whether the agent
 * asks for your APPROVAL before it runs an action while carrying out a task you
 * asked for. It does NOT make the agent decide tasks or act unprompted — an agent
 * never self-triggers; it always works within a request you made and the tools you
 * granted it. Wording must never imply otherwise.
 */
export const AUTONOMY_OPTIONS: { value: AutonomyLevel; name: string; description: string }[] = [
  {
    value: 'propose_confirm',
    name: 'Propose & confirm',
    description:
      'New agents and tools start on Ask first for every action that asks by default: shell commands, skill scripts, connector writes, third-party tools and the ROOT meta-tools (create agent, skill…) wait in the Approvals queue before running.',
  },
  {
    value: 'destructive_gate',
    name: 'Autonomous, gate destructive',
    description:
      'New agents and tools start on Run without asking for ordinary actions (normal commands, meta-tools, third-party tools), and on Ask first for destructive ones: deletions, skill scripts, coding tasks. Commands follow each agent’s list of kinds of action (installs, downloads, killing processes ask). No friction for routine work, a checkpoint before anything risky.',
  },
  {
    value: 'fully_autonomous',
    name: 'Fully autonomous',
    description:
      'New agents and tools start on Run without asking, except what runs code on this machine (commands, scripts, coding tasks), which starts on Ask first. Truly catastrophic shell commands (wiping the disk, etc.) always force a confirmation. Use only if you fully trust it.',
  },
];
