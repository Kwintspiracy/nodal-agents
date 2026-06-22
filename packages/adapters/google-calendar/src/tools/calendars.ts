// @nodal-agents/adapter-google-calendar — calendar + free/busy tools

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { calendar_v3 } from 'googleapis';
import { mapGoogleCalendarError } from '../errors';

// ── gcal_list_calendars ─────────────────────────────────────────────────────────

const ListCalendarsInput = z.object({});

export type ListCalendarsOutput = {
  total: number;
  calendars: Array<{
    id: string;
    summary: string;
    description: string;
    primary: boolean;
    accessRole: string;
    timeZone: string;
  }>;
};

export function createListCalendarsTool(
  calendar: calendar_v3.Calendar,
): ToolDefinition<typeof ListCalendarsInput, ListCalendarsOutput> {
  return {
    name: 'gcal_list_calendars',
    description:
      'List the calendars the user can access. Returns calendar IDs (use the id with the other ' +
      "gcal_* tools; 'primary' is the user's main calendar).",
    inputSchema: ListCalendarsInput,
    riskLevel: 'read',
    async execute() {
      try {
        const res = await calendar.calendarList.list();
        const calendars = (res.data.items ?? []).map((c) => ({
          id: c.id ?? '',
          summary: c.summary ?? '',
          description: c.description ?? '',
          primary: Boolean(c.primary),
          accessRole: c.accessRole ?? '',
          timeZone: c.timeZone ?? '',
        }));
        return { total: calendars.length, calendars };
      } catch (err) {
        throw mapGoogleCalendarError(err);
      }
    },
  };
}

// ── gcal_find_free_slots ────────────────────────────────────────────────────────

const FindFreeSlotsInput = z.object({
  time_min: z.string().describe('ISO 8601 start of the window to check.'),
  time_max: z.string().describe('ISO 8601 end of the window to check.'),
  calendar_ids: z
    .array(z.string())
    .optional()
    .describe("Calendar IDs to check (default ['primary'])."),
});

export type FindFreeSlotsOutput = {
  timeMin: string;
  timeMax: string;
  busy: Record<string, Array<{ start: string; end: string }>>;
};

export function createFindFreeSlotsTool(
  calendar: calendar_v3.Calendar,
): ToolDefinition<typeof FindFreeSlotsInput, FindFreeSlotsOutput> {
  return {
    name: 'gcal_find_free_slots',
    description:
      'Query busy intervals across one or more calendars in a time window, so you can find ' +
      'free slots for scheduling. Returns the BUSY ranges per calendar — gaps are free.',
    inputSchema: FindFreeSlotsInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const ids = input.calendar_ids ?? ['primary'];
        const res = await calendar.freebusy.query({
          requestBody: {
            timeMin: input.time_min,
            timeMax: input.time_max,
            items: ids.map((id) => ({ id })),
          },
        });
        const busy: Record<string, Array<{ start: string; end: string }>> = {};
        const calendars = res.data.calendars ?? {};
        for (const [id, cal] of Object.entries(calendars)) {
          busy[id] = (cal.busy ?? []).map((b) => ({
            start: b.start ?? '',
            end: b.end ?? '',
          }));
        }
        return {
          timeMin: input.time_min,
          timeMax: input.time_max,
          busy,
        };
      } catch (err) {
        throw mapGoogleCalendarError(err);
      }
    },
  };
}
