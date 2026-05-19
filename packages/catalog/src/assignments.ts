// catalog/assignments.ts — default skill→agent links shipped with the product.
//
// On boot the seeder ensures each entry exists in `agent_skill_assignments`
// for the local entity. Idempotent — repeated boots / cron ticks do not
// create duplicates. Users can detach a default assignment via the dashboard;
// removed assignments are NOT re-created by the seeder (would override user
// intent on every boot).
//
// To track "user removed this default assignment" we look at the existing
// row count: if assignment for (agentSlug, skillSlug) is missing AND the
// agent exists, we create it once at first seed. After that, if the user
// deletes it, we don't recreate (a separate marker would be needed for
// "originally seeded then deleted" — pragmatic for v1: create on first
// boot only, never recreate).

import type { SystemAssignment } from './types';

export const systemAssignments: SystemAssignment[] = [
  { agentSlug: 'concierge', skillSlug: 'telegram-responder' },
  { agentSlug: 'note-taker', skillSlug: 'obsidian' },
  { agentSlug: 'summarizer', skillSlug: 'research-scope-discipline' },
  { agentSlug: 'coding-agent', skillSlug: 'claude-html-design' },
];
