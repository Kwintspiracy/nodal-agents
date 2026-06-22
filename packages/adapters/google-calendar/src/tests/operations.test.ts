// operations.test.ts — regression lock: GOOGLE_CALENDAR_OPERATIONS slugs must
// match the tool names produced by createGoogleCalendarTools(). If a tool is
// added/renamed without updating the operations list, this fails immediately.

import { describe, it, expect } from 'vitest';
import { createGoogleCalendarTools, GOOGLE_CALENDAR_OPERATIONS } from '../index.ts';

describe('GOOGLE_CALENDAR_OPERATIONS slugs match factory tool names', () => {
  it('slug set equals tool name set', () => {
    const tools = createGoogleCalendarTools({ accessToken: 'mock-token' });
    const toolNames = tools.map((t) => t.name).sort();
    const opSlugs = GOOGLE_CALENDAR_OPERATIONS.map((o) => o.slug).sort();
    expect(opSlugs).toEqual(toolNames);
  });

  it('ships the expected calendar capabilities', () => {
    const slugs = GOOGLE_CALENDAR_OPERATIONS.map((o) => o.slug);
    for (const expected of [
      'gcal_list_calendars',
      'gcal_list_events',
      'gcal_get_event',
      'gcal_create_event',
      'gcal_update_event',
      'gcal_delete_event',
      'gcal_find_free_slots',
    ]) {
      expect(slugs).toContain(expected);
    }
  });

  it('delete is classified destructive; create/update are write', () => {
    const bySlug = new Map(GOOGLE_CALENDAR_OPERATIONS.map((o) => [o.slug, o]));
    expect(bySlug.get('gcal_delete_event')?.risk).toBe('destructive');
    expect(bySlug.get('gcal_create_event')?.risk).toBe('write');
    expect(bySlug.get('gcal_update_event')?.risk).toBe('write');
    expect(bySlug.get('gcal_list_events')?.risk).toBe('read');
  });

  it('no duplicate slugs / tool names', () => {
    const slugs = GOOGLE_CALENDAR_OPERATIONS.map((o) => o.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const names = createGoogleCalendarTools({ accessToken: 'mock-token' }).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
