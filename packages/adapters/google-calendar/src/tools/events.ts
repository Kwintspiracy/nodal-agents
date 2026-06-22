// @nodal-agents/adapter-google-calendar — event tools
// list, get, create, update, delete

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { calendar_v3 } from 'googleapis';
import { mapGoogleCalendarError } from '../errors';

/** Compact event shape returned to the agent (the raw API event is huge). */
export type CalendarEvent = {
  id: string;
  summary: string;
  description: string;
  location: string;
  status: string;
  start: string;
  end: string;
  allDay: boolean;
  htmlLink: string;
  attendees: string[];
  organizer: string;
};

function toCompactEvent(e: calendar_v3.Schema$Event): CalendarEvent {
  const start = e.start?.dateTime ?? e.start?.date ?? '';
  const end = e.end?.dateTime ?? e.end?.date ?? '';
  return {
    id: e.id ?? '',
    summary: e.summary ?? '',
    description: e.description ?? '',
    location: e.location ?? '',
    status: e.status ?? '',
    start,
    end,
    allDay: Boolean(e.start?.date) && !e.start?.dateTime,
    htmlLink: e.htmlLink ?? '',
    attendees: (e.attendees ?? []).map((a) => a.email ?? '').filter((s) => s !== ''),
    organizer: e.organizer?.email ?? '',
  };
}

const CALENDAR_ID = z
  .string()
  .optional()
  .describe("Calendar ID (from gcal_list_calendars). Defaults to 'primary'.");

// ── gcal_list_events ────────────────────────────────────────────────────────────

const ListEventsInput = z.object({
  calendar_id: CALENDAR_ID,
  time_min: z
    .string()
    .optional()
    .describe('ISO 8601 lower bound (inclusive). Defaults to now — i.e. upcoming events.'),
  time_max: z.string().optional().describe('ISO 8601 upper bound (exclusive).'),
  query: z.string().optional().describe('Free-text search over event fields.'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(250)
    .optional()
    .describe('Max events to return (default 25).'),
});

export type ListEventsOutput = { total: number; events: CalendarEvent[] };

export function createListEventsTool(
  calendar: calendar_v3.Calendar,
): ToolDefinition<typeof ListEventsInput, ListEventsOutput> {
  return {
    name: 'gcal_list_events',
    description:
      'List calendar events in a time range. Defaults to UPCOMING events from now. ' +
      'Use time_min/time_max (ISO 8601) to bound, query to text-search. Returns event IDs.',
    inputSchema: ListEventsInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const res = await calendar.events.list({
          calendarId: input.calendar_id ?? 'primary',
          timeMin: input.time_min ?? new Date().toISOString(),
          timeMax: input.time_max,
          q: input.query,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: input.max_results ?? 25,
        });
        const events = (res.data.items ?? []).map(toCompactEvent);
        return { total: events.length, events };
      } catch (err) {
        throw mapGoogleCalendarError(err);
      }
    },
  };
}

// ── gcal_get_event ──────────────────────────────────────────────────────────────

const GetEventInput = z.object({
  calendar_id: CALENDAR_ID,
  event_id: z.string().describe('Event ID (from gcal_list_events).'),
});

export function createGetEventTool(
  calendar: calendar_v3.Calendar,
): ToolDefinition<typeof GetEventInput, CalendarEvent> {
  return {
    name: 'gcal_get_event',
    description: 'Get the full details of a single calendar event by ID.',
    inputSchema: GetEventInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const res = await calendar.events.get({
          calendarId: input.calendar_id ?? 'primary',
          eventId: input.event_id,
        });
        return toCompactEvent(res.data);
      } catch (err) {
        throw mapGoogleCalendarError(err);
      }
    },
  };
}

// ── gcal_create_event ───────────────────────────────────────────────────────────

const CreateEventInput = z.object({
  calendar_id: CALENDAR_ID,
  summary: z.string().describe('Event title.'),
  start: z
    .string()
    .describe(
      'Start time. ISO 8601 datetime (e.g. 2026-07-01T14:00:00+02:00) or YYYY-MM-DD for an all-day event.',
    ),
  end: z
    .string()
    .describe('End time. ISO 8601 datetime or YYYY-MM-DD (exclusive) for an all-day event.'),
  description: z.string().optional().describe('Event description/notes.'),
  location: z.string().optional().describe('Event location.'),
  attendees: z.array(z.string()).optional().describe('Attendee email addresses to invite.'),
  time_zone: z.string().optional().describe("IANA time zone for the times (e.g. 'Europe/Paris')."),
});

export type WriteEventOutput = { id: string; htmlLink: string; summary: string };

/** YYYY-MM-DD (all-day) vs a full datetime → the right Calendar time object. */
function toEventTime(value: string, timeZone?: string): calendar_v3.Schema$EventDateTime {
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (isDateOnly) return { date: value };
  return timeZone ? { dateTime: value, timeZone } : { dateTime: value };
}

export function createCreateEventTool(
  calendar: calendar_v3.Calendar,
): ToolDefinition<typeof CreateEventInput, WriteEventOutput> {
  return {
    name: 'gcal_create_event',
    description:
      'Create a new calendar event. Use ISO 8601 datetimes for timed events, or YYYY-MM-DD ' +
      'for all-day events. Optionally invite attendees by email.',
    inputSchema: CreateEventInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const res = await calendar.events.insert({
          calendarId: input.calendar_id ?? 'primary',
          requestBody: {
            summary: input.summary,
            description: input.description,
            location: input.location,
            start: toEventTime(input.start, input.time_zone),
            end: toEventTime(input.end, input.time_zone),
            attendees: input.attendees?.map((email) => ({ email })),
          },
        });
        return {
          id: res.data.id ?? '',
          htmlLink: res.data.htmlLink ?? '',
          summary: res.data.summary ?? '',
        };
      } catch (err) {
        throw mapGoogleCalendarError(err);
      }
    },
  };
}

// ── gcal_update_event ───────────────────────────────────────────────────────────

const UpdateEventInput = z.object({
  calendar_id: CALENDAR_ID,
  event_id: z.string().describe('Event ID to update (from gcal_list_events).'),
  summary: z.string().optional().describe('New event title.'),
  start: z.string().optional().describe('New start (ISO 8601 datetime or YYYY-MM-DD).'),
  end: z.string().optional().describe('New end (ISO 8601 datetime or YYYY-MM-DD).'),
  description: z.string().optional().describe('New description.'),
  location: z.string().optional().describe('New location.'),
  attendees: z.array(z.string()).optional().describe('Replace the attendee email list.'),
  time_zone: z.string().optional().describe('IANA time zone for the times.'),
});

export function createUpdateEventTool(
  calendar: calendar_v3.Calendar,
): ToolDefinition<typeof UpdateEventInput, WriteEventOutput> {
  return {
    name: 'gcal_update_event',
    description:
      'Update an existing calendar event. Only the fields you provide are changed (patch semantics).',
    inputSchema: UpdateEventInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const requestBody: calendar_v3.Schema$Event = {};
        if (input.summary !== undefined) requestBody.summary = input.summary;
        if (input.description !== undefined) requestBody.description = input.description;
        if (input.location !== undefined) requestBody.location = input.location;
        if (input.start !== undefined)
          requestBody.start = toEventTime(input.start, input.time_zone);
        if (input.end !== undefined) requestBody.end = toEventTime(input.end, input.time_zone);
        if (input.attendees !== undefined)
          requestBody.attendees = input.attendees.map((email) => ({ email }));

        const res = await calendar.events.patch({
          calendarId: input.calendar_id ?? 'primary',
          eventId: input.event_id,
          requestBody,
        });
        return {
          id: res.data.id ?? '',
          htmlLink: res.data.htmlLink ?? '',
          summary: res.data.summary ?? '',
        };
      } catch (err) {
        throw mapGoogleCalendarError(err);
      }
    },
  };
}

// ── gcal_delete_event ───────────────────────────────────────────────────────────

const DeleteEventInput = z.object({
  calendar_id: CALENDAR_ID,
  event_id: z.string().describe('Event ID to permanently delete.'),
});

export type DeleteEventOutput = { deleted: boolean; eventId: string };

export function createDeleteEventTool(
  calendar: calendar_v3.Calendar,
): ToolDefinition<typeof DeleteEventInput, DeleteEventOutput> {
  return {
    name: 'gcal_delete_event',
    description: 'Permanently delete a calendar event. This cannot be undone.',
    inputSchema: DeleteEventInput,
    riskLevel: 'destructive',
    async execute(input) {
      try {
        await calendar.events.delete({
          calendarId: input.calendar_id ?? 'primary',
          eventId: input.event_id,
        });
        return { deleted: true, eventId: input.event_id };
      } catch (err) {
        throw mapGoogleCalendarError(err);
      }
    },
  };
}
