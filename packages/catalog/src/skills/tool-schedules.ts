// catalog/skills/tool-schedules.ts — usage guide for the schedule meta-tools.
// Loaded on demand via skill_view('tool-schedules'). Seeded, never auto-assigned.

import type { SystemSkill } from '../types';

export const toolSchedulesSkill: SystemSkill = {
  slug: 'tool-schedules',
  name: 'Using schedules',
  description: 'How to create/edit/pause/run recurring schedules for an agent.',
  requiredBuiltins: [],
  content: `## Using schedules

A schedule fires a task for an agent on a recurring timer. Tools:
- **list_schedules** — see all schedules (name, agent, when, next/last run). Use it to answer "what are my automations?" and to find a name.
- **create_schedule** — agentSlug, name, when (atTimes OR everyMinutes), task, (days?, notifyOnSuccess?).
- **update_schedule** — name + any of atTimes / everyMinutes / days / task / newName / notifyOnSuccess.
- **toggle_schedule** — name + active (true = resume, false = pause).
- **run_schedule** — name: fire a schedule's task NOW, without waiting.

You cannot DELETE a schedule — deleting is a user action (dashboard only). To stop one, **pause** it with toggle_schedule (active=false).

### Setting WHEN — give clock times, the system owns the timezone
You set timing two ways (pick one):
- **atTimes**: a list of wall-clock times "HH:MM" (24h) — e.g. \`["09:00","13:00","21:00"]\`.
- **everyMinutes**: an interval — e.g. \`15\`, \`30\`, \`60\`, \`120\`.

You give the hours **exactly as the user says them** (their local time). You do NOT write cron and
you do NOT set or convert timezones — the workspace timezone is a system setting, and the Runtime
block in your prompt tells you the current local time. There is no UTC conversion to do.

| User says | call |
|---|---|
| every day at 9am | \`atTimes: ["09:00"]\` |
| 9am, 1pm and 9pm daily | \`atTimes: ["09:00","13:00","21:00"]\` |
| 8:30 on weekdays | \`atTimes: ["08:30"], days: "weekdays"\` |
| 7am Sat & Sun | \`atTimes: ["07:00"], days: "weekends"\` |
| 6pm Mon & Thu | \`atTimes: ["18:00"], days: [1,4]\` |
| every 30 minutes | \`everyMinutes: 30\` |
| every 2 hours | \`everyMinutes: 120\` |

\`days\`: omit for daily, or "weekdays" (Mon-Fri) / "weekends" / an array 0=Sun..6=Sat.
**One schedule covers several times** — put them all in atTimes, don't make one schedule per time.
(All atTimes must share the same minute, e.g. 09:00/13:00/21:00.)

### Worked example
\`\`\`json
{ "agentSlug": "researcher", "name": "Daily market scan", "atTimes": ["09:00"], "days": "weekdays", "task": "Scan overnight news and post a 5-bullet summary.", "notifyOnSuccess": true }
\`\`\`

### Notes
- \`notifyOnSuccess\` defaults false → runs silently. Set true if the user should get a confirmation each run.
- The agent referenced by agentSlug must exist (create it first).
- Need an exotic pattern (e.g. "1st of every month")? That's a dashboard-only setup — tell the user.
`,
};
