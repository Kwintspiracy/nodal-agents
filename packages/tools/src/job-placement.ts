// job-placement.ts — where a job sits, the part of its tool whitelist that
// does not come from the agent (#636). No imports: read by the whitelist rule,
// the ToolContext type and the routine lint alike.

/** Where a job sits — the part of the whitelist that is not the agent's. */
export interface JobPlacement {
  /** Delegated by another job (`agent_jobs.parent_job_id` set). */
  delegated: boolean;
  /** Run of a routine (`agent_jobs.schedule_id` set). */
  routine: boolean;
  /** Turn of a conversation (`agent_jobs.conversation_id` set). */
  inConversation: boolean;
}

/** A fresh top-level job: typed by hand, from the dashboard, the API. */
export const TOP_LEVEL_JOB: JobPlacement = {
  delegated: false,
  routine: false,
  inConversation: false,
};

/** A routine run, as run-schedules.ts creates it: top-level, no conversation. */
export const ROUTINE_RUN: JobPlacement = {
  delegated: false,
  routine: true,
  inConversation: false,
};
