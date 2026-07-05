// @nodal-agents/adapter-google-calendar — public API
// Single factory: createGoogleCalendarTools(opts) → ToolDefinition[]

import type { ToolDefinition } from '@nodal-agents/tools';
import type { z } from 'zod';
import { createGoogleCalendarClient } from './client';

// Events (5)
import {
  createListEventsTool,
  createGetEventTool,
  createCreateEventTool,
  createUpdateEventTool,
  createDeleteEventTool,
} from './tools/events';

// Calendars + free/busy (2)
import { createListCalendarsTool, createFindFreeSlotsTool } from './tools/calendars';

export type GoogleCalendarAdapterOptions =
  | {
      /**
       * Static OAuth2 access token, captured once for the tools' lifetime.
       * Fine for short-lived callers (tests, the UI operations grid). Jobs
       * that may outlive the ~1h Google token TTL should pass getAccessToken
       * instead (audit#2 M-12).
       */
      accessToken: string;
    }
  | {
      /**
       * Resolver called before every Calendar API request — re-reads (and,
       * via the runner's advisory-lock refresh path, refreshes) the
       * credential from the DB instead of capturing one token for the
       * tools' lifetime.
       */
      getAccessToken: () => Promise<string>;
    };

/**
 * Create all 7 Google Calendar tools using the provided OAuth access token.
 * Returns a flat ToolDefinition[] ready to register in a ToolRegistry.
 *
 * Tool count: 7
 * Read (4):        gcal_list_calendars, gcal_list_events, gcal_get_event,
 *                  gcal_find_free_slots
 * Write (2):       gcal_create_event, gcal_update_event
 * Destructive (1): gcal_delete_event
 */
export function createGoogleCalendarTools(
  opts: GoogleCalendarAdapterOptions,
): ToolDefinition<z.ZodTypeAny, unknown>[] {
  const getAccessToken =
    'getAccessToken' in opts ? opts.getAccessToken : async () => opts.accessToken;
  const calendar = createGoogleCalendarClient(getAccessToken);

  return [
    // Read tools (4)
    createListCalendarsTool(calendar),
    createListEventsTool(calendar),
    createGetEventTool(calendar),
    createFindFreeSlotsTool(calendar),

    // Write tools (2)
    createCreateEventTool(calendar),
    createUpdateEventTool(calendar),

    // Destructive tools (1)
    createDeleteEventTool(calendar),
  ] as unknown as ToolDefinition<z.ZodTypeAny, unknown>[];
}

// Re-export error types for consumers
export { GoogleCalendarAdapterError } from './errors';
export type { GoogleCalendarErrorCode } from './errors';

// Re-export operation descriptors for UI and registry consumers
export { GOOGLE_CALENDAR_OPERATIONS } from './operations';
