import type { AutonomyLevel } from '@nodal-agents/shared';

/**
 * Single source of truth for how the three autonomy levels are presented — used
 * IDENTICALLY (same text, same order) by Settings → ROOT agent (RootAgentSection)
 * and the onboarding autonomy step (OnboardingFlow). Order matches the
 * `AutonomyLevel` enum: propose_confirm → destructive_gate → fully_autonomous.
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
      'While doing what you ask, it pauses for your approval before every action: shell commands, skill scripts, connector writes and the ROOT meta-tools (create agent, skill…) all wait in the Approvals queue before running.',
  },
  {
    value: 'destructive_gate',
    name: 'Autonomous, gate destructive',
    description:
      'While doing what you ask, ordinary actions run without interrupting you (normal commands, scripts, meta-tools). But destructive or heavy ones still ask first: deletions, software installs / large downloads, killing processes, disk operations. The sweet spot — no friction for routine work, a checkpoint before anything risky.',
  },
  {
    value: 'fully_autonomous',
    name: 'Fully autonomous',
    description:
      'While doing what you ask, nothing pauses for approval — every command, script and connector action, plus the ROOT meta-tools, run straight through. Only truly catastrophic shell commands (wiping the disk, etc.) still force a confirmation. Maximum power, no friction: use only if you fully trust it.',
  },
];
