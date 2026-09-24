// shell-checklist.ts — judging a shell command against the agent's checklist (#464).
//
// Each command the call will run is read for the kinds of action it performs
// (`staticShellCategories`, packages/shared), and the state the owner gave
// each kind applies. What it returns is FACTS: one reason per kind whose state
// is `ask` or `never`, with the commands that did it. The caller
// (`executeTool`) turns them into a block or an approval, and stores them on
// the approval so the card can show them.
//
// A reading of the text, like Hermes Agent's: it does not follow what a script
// does once it runs, and it does not keep an agent inside its folders. That
// takes an OS-level sandbox.

import {
  staticShellCategories,
  type ShellCategory,
  type ShellGateReason,
  type ShellPolicy,
} from '@nodal-agents/shared';

/** Judge `commands` (the ones this call will run) against `policy`. */
export function judgeShellChecklist(
  commands: readonly string[],
  policy: ShellPolicy,
): ShellGateReason[] {
  const details = new Map<ShellCategory, string[]>();
  for (const command of commands) {
    for (const category of staticShellCategories(command)) {
      if (policy[category] === 'allow') continue;
      const list = details.get(category) ?? [];
      if (!list.includes(command)) list.push(command);
      details.set(category, list);
    }
  }

  const reasons: ShellGateReason[] = [];
  for (const [category, list] of details) {
    const state = policy[category];
    if (state === 'allow') continue;
    reasons.push({ category, state, details: list });
  }
  return reasons;
}

/** How the model reads each kind of action in a refusal (never shown to a person). */
const CATEGORY_FOR_MODEL: Record<ShellCategory, string> = {
  inline_code: 'run code written into a command (python -c, node -e and the like)',
  delete_files: 'delete files or discard work',
  install_software: 'install software or packages',
  download: 'download from the internet',
  stop_programs: 'stop other programs or services',
  system_settings: 'change system settings, permissions or disks',
};

/**
 * The refusal the MODEL reads when a kind of action is set to "never".
 * Prescriptive, like the rule refusal: what is forbidden and that it is
 * intentional — otherwise the model retries or works around it.
 */
export function shellChecklistRefusal(never: readonly ShellGateReason[]): string {
  const what = never.map((r) => CATEGORY_FOR_MODEL[r.category]).join('; ');
  return (
    `blocked: the owner does not allow this agent to ${what}. This is an intentional ` +
    `restriction — do NOT retry it and do NOT work around it via other commands, scripts, ` +
    `tools or sub-agents. Use your allowed tools, or report the limitation in your result.`
  );
}
