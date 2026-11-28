// Google Calendar adapter operation descriptors.
// Each slug MUST match the tool name produced by createGoogleCalendarTools() exactly.
// Risk classification:
//   read        — gcal_list_*, gcal_get_*, gcal_find_free_slots
//   write       — gcal_create_event, gcal_update_event (reversible)
//   destructive — gcal_delete_event (irreversible)

import type { OperationDescriptor, ScopeRequirement } from '@nodal-agents/shared';

// OAuth rights, from the Calendar API reference ("Authorization scopes" of
// events.*, calendarList.list and freebusy.query). First = what Nodal asks for;
// the others are broader scopes Google also accepts for the same calls.
const CAL = 'https://www.googleapis.com/auth/calendar';
const EVENTS: ScopeRequirement = [`${CAL}.events`, CAL];
const CALENDAR_LIST: ScopeRequirement = [
  `${CAL}.calendarlist.readonly`,
  `${CAL}.calendarlist`,
  `${CAL}.readonly`,
  CAL,
];
const FREEBUSY: ScopeRequirement = [`${CAL}.freebusy`, `${CAL}.readonly`, CAL];

export const GOOGLE_CALENDAR_OPERATIONS: OperationDescriptor[] = [
  // ─── Read (4) ────────────────────────────────────────────────────────────────
  {
    slug: 'gcal_list_calendars',
    name: 'List calendars',
    risk: 'read',
    requiresApproval: false,
    scopes: [CALENDAR_LIST],
    description: 'List the calendars the user has access to.',
  },
  {
    slug: 'gcal_list_events',
    name: 'List events',
    risk: 'read',
    requiresApproval: false,
    scopes: [EVENTS],
    description: 'List events on a calendar within a time range (defaults to upcoming).',
  },
  {
    slug: 'gcal_get_event',
    name: 'Get event',
    risk: 'read',
    requiresApproval: false,
    scopes: [EVENTS],
    description: 'Retrieve a single event by ID.',
  },
  {
    slug: 'gcal_find_free_slots',
    name: 'Find free slots',
    risk: 'read',
    requiresApproval: false,
    scopes: [FREEBUSY],
    description: 'Query busy/free intervals across calendars for scheduling.',
  },

  // ─── Write (2) ───────────────────────────────────────────────────────────────
  {
    slug: 'gcal_create_event',
    name: 'Create event',
    risk: 'write',
    requiresApproval: false,
    scopes: [EVENTS],
    description: 'Create a new calendar event (optionally inviting attendees).',
  },
  {
    slug: 'gcal_update_event',
    name: 'Update event',
    risk: 'write',
    requiresApproval: false,
    scopes: [EVENTS],
    description: 'Update an existing calendar event.',
  },

  // ─── Destructive (1) ─────────────────────────────────────────────────────────
  {
    slug: 'gcal_delete_event',
    name: 'Delete event',
    risk: 'destructive',
    requiresApproval: true,
    scopes: [EVENTS],
    description: 'Permanently delete a calendar event.',
  },
];
