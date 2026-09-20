// Automations — the ways a job can start WITHOUT anyone typing a message.
//
// There was no single registry for this, which is exactly why the system prompt
// never mentioned automations: a prompt can only advertise what it can read,
// and the two trigger kinds lived only in their own tables. The membership of
// this list is not invented, it is the two entities the product ships:
//   - `cron`    → `agent_schedules` (entities/schedule.ts, SCHEDULE_TYPES)
//   - `webhook` → `webhook_triggers` (entities/webhook-trigger.ts)
//
// `heartbeat`, the other value of SCHEDULE_TYPES, is deliberately absent: it is
// in the table's CHECK constraint and nothing in the repository ever writes it
// (`grep -rn heartbeat apps packages` finds only the runner's job heartbeat,
// which is a different thing entirely). Offering an agent something no screen
// can create would be the CONNECTOR_CAPABILITY mistake in a new place.
//
// A watcher is not a third kind: it is a cron schedule on a short interval that
// looks for what changed since its last run, which is why it is named on the
// cron entry rather than given one of its own.

export interface AutomationKind {
  /** Stable identifier, and the `agent_jobs.channel` a fired job carries. */
  kind: 'cron' | 'webhook';
  /** What it is, in the words of someone deciding whether they want one. */
  summary: string;
  /** Where the owner creates it, named the way the dashboard names it. */
  where: string;
}

export const AUTOMATION_KINDS: readonly AutomationKind[] = [
  {
    kind: 'cron',
    summary:
      'run on a schedule, from every few minutes to once a month (a watcher is one of these on a short interval, looking for what changed since its last run)',
    where: 'the Run board in the sidebar, Cron section',
  },
  {
    kind: 'webhook',
    summary: 'run when something outside posts to a URL, with the posted data in the brief',
    where: 'the Run board in the sidebar, Webhooks section',
  },
];
