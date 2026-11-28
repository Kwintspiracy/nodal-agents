// schedule-change-cases.ts — ONE table of "what exists × what changes", read by the
// three suites that must agree: the pure function (shared), the agent's
// update_schedule tool (tools) and the dashboard's updateScheduleAction (web).
// A change gives the same stored row through every one of them, because the
// expected row is written here once.
//
// A test fixture: imported by tests only (package export "./schedule-change-cases").

import type { ScheduleChange, ScheduleState } from '../schedule-change';

/** The fields every stored row starts with, chosen so that NO default can hide a reset. */
export const BASE_SCHEDULE = {
  name: 'Standup',
  task: 'Post the standup summary',
  notifyOnSuccess: true, // the form default is false
  notifyChannel: null,
  dailyBudgetUsd: 7.5, // the default is 5
} as const;

export type NamedField = Exclude<keyof ScheduleState, 'agentId'>;

export type ScheduleChangeCase = {
  title: string;
  /** How the schedule is stored (however it was created). */
  stored: { cronExpr: string; timezone: string | null };
  /** What the caller names. */
  change: Omit<ScheduleChange, 'agentId'>;
  /**
   * `set`: the stored fields that differ afterwards (everything else must be
   * kept). `error`: the change is refused and nothing is written.
   */
  expect: { set: Partial<Pick<ScheduleState, NamedField>> } | { error: RegExp };
  /** The agent's tool names neither the zone nor the notify channel: those cases are for the other writers. */
  toolCannotName?: boolean;
};

const PARIS = 'Europe/Paris';

export const SCHEDULE_CHANGE_CASES: ScheduleChangeCase[] = [
  // ── the reported scenario: moving the time of a weekday schedule ──
  {
    title: 'weekdays 09:00 moved to 10:00 stays on weekdays',
    stored: { cronExpr: '0 9 * * 1-5', timezone: PARIS },
    change: { atTimes: ['10:00'] },
    expect: { set: { cronExpr: '0 10 * * 1-5' } },
  },
  // ── what exists × changing the time ──
  {
    title: 'daily moved to 10:30',
    stored: { cronExpr: '0 9 * * *', timezone: PARIS },
    change: { atTimes: ['10:30'] },
    expect: { set: { cronExpr: '30 10 * * *' } },
  },
  {
    title: 'one weekday keeps that weekday',
    stored: { cronExpr: '0 9 * * 2', timezone: PARIS },
    change: { atTimes: ['08:00'] },
    expect: { set: { cronExpr: '0 8 * * 2' } },
  },
  {
    title: 'several days of the week keep their days',
    stored: { cronExpr: '30 8 * * 1,3,5', timezone: PARIS },
    change: { atTimes: ['18:15'] },
    expect: { set: { cronExpr: '15 18 * * 1,3,5' } },
  },
  {
    title: 'several times a day replaced by one',
    stored: { cronExpr: '0 9,13,21 * * *', timezone: PARIS },
    change: { atTimes: ['10:00'] },
    expect: { set: { cronExpr: '0 10 * * *' } },
  },
  {
    title: 'one time a day replaced by several, weekends kept',
    stored: { cronExpr: '0 9 * * 0,6', timezone: PARIS },
    change: { atTimes: ['09:00', '13:00', '21:00'] },
    expect: { set: { cronExpr: '0 9,13,21 * * 0,6' } },
  },
  {
    title: 'monthly (day of month) moved to 10:00 stays monthly',
    stored: { cronExpr: '0 9 1 * *', timezone: PARIS },
    change: { atTimes: ['10:00'] },
    expect: { set: { cronExpr: '0 10 1 * *' } },
  },
  {
    title: 'a month restriction is kept when the time moves',
    stored: { cronExpr: '0 9 * 6-8 1-5', timezone: PARIS },
    change: { atTimes: ['07:45'] },
    expect: { set: { cronExpr: '45 7 * 6-8 1-5' } },
  },
  // ── what exists × changing the interval ──
  {
    title: 'every 30 minutes becomes every 15',
    stored: { cronExpr: '*/30 * * * *', timezone: PARIS },
    change: { everyMinutes: 15 },
    expect: { set: { cronExpr: '*/15 * * * *' } },
  },
  {
    title: 'a weekend interval moved to every 2 hours keeps the weekend',
    stored: { cronExpr: '*/30 * * * 0,6', timezone: PARIS },
    change: { everyMinutes: 120 },
    expect: { set: { cronExpr: '0 */2 * * 0,6' } },
  },
  {
    title: 'every 30 minutes switched to a fixed time',
    stored: { cronExpr: '*/30 * * * *', timezone: PARIS },
    change: { atTimes: ['09:00'] },
    expect: { set: { cronExpr: '0 9 * * *' } },
  },
  {
    title: 'a daily time switched to an interval keeps its weekdays',
    stored: { cronExpr: '0 9 * * 1-5', timezone: PARIS },
    change: { everyMinutes: 60 },
    expect: { set: { cronExpr: '0 */1 * * 1-5' } },
  },
  // ── what exists × changing the days ──
  {
    title: 'days changed keeps the times (several of them)',
    stored: { cronExpr: '0 9,13,21 * * *', timezone: PARIS },
    change: { days: 'weekdays' },
    expect: { set: { cronExpr: '0 9,13,21 * * 1-5' } },
  },
  {
    title: 'days changed to a list',
    stored: { cronExpr: '0 9 * * 1-5', timezone: PARIS },
    change: { days: [5, 1, 3, 3] },
    expect: { set: { cronExpr: '0 9 * * 1,3,5' } },
  },
  {
    title: 'days changed back to daily',
    stored: { cronExpr: '0 9 * * 1-5', timezone: PARIS },
    change: { days: 'daily' },
    expect: { set: { cronExpr: '0 9 * * *' } },
  },
  {
    title: 'days changed on an interval keeps the interval',
    stored: { cronExpr: '*/30 * * * *', timezone: PARIS },
    change: { days: 'weekends' },
    expect: { set: { cronExpr: '*/30 * * * 0,6' } },
  },
  {
    title: 'time and days named together change both',
    stored: { cronExpr: '0 9 * * *', timezone: PARIS },
    change: { atTimes: ['10:00'], days: 'weekdays' },
    expect: { set: { cronExpr: '0 10 * * 1-5' } },
  },
  // ── what exists × the timing the fields cannot express (hand-written cron) ──
  {
    title: 'a hand-written range-and-step cron is not rewritten by atTimes',
    stored: { cronExpr: '*/10 9-17 * * 1-5', timezone: PARIS },
    change: { atTimes: ['10:00'] },
    expect: { error: /\*\/10 9-17 \* \* 1-5[\s\S]*not changed/ },
  },
  {
    title: 'a hand-written range-and-step cron is not rewritten by everyMinutes',
    stored: { cronExpr: '*/10 9-17 * * 1-5', timezone: PARIS },
    change: { everyMinutes: 30 },
    expect: { error: /\*\/10 9-17 \* \* 1-5[\s\S]*not changed/ },
  },
  {
    title: 'a hand-written cron still takes a days change (only its day field moves)',
    stored: { cronExpr: '*/10 9-17 * * 1-5', timezone: PARIS },
    change: { days: 'weekends' },
    expect: { set: { cronExpr: '*/10 9-17 * * 0,6' } },
  },
  {
    title: 'a cron with a day of month refuses days (cron would OR the two)',
    stored: { cronExpr: '0 9 1 * *', timezone: PARIS },
    change: { days: 'weekdays' },
    expect: { error: /day-of-month "1"[\s\S]*not changed/ },
  },
  {
    title: 'a six-field cron is not rewritten',
    stored: { cronExpr: '0 0 9 * * 1-5', timezone: PARIS },
    change: { atTimes: ['10:00'] },
    expect: { error: /five cron fields[\s\S]*not changed/ },
  },
  {
    title: 'a macro cron is not rewritten',
    stored: { cronExpr: '@daily', timezone: PARIS },
    change: { days: 'weekdays' },
    expect: { error: /@daily[\s\S]*not changed/ },
  },
  // ── what exists × changing something that is not the timing ──
  {
    title: 'the instruction alone keeps the whole timing',
    stored: { cronExpr: '*/10 9-17 * * 1-5', timezone: PARIS },
    change: { task: 'Post the weekly summary' },
    expect: { set: { task: 'Post the weekly summary' } },
  },
  {
    title: 'the name alone keeps the whole timing',
    stored: { cronExpr: '0 9 1 * *', timezone: PARIS },
    change: { name: 'Monthly report' },
    expect: { set: { name: 'Monthly report' } },
  },
  {
    title: 'the notification alone keeps the rest',
    stored: { cronExpr: '0 9 * * 1-5', timezone: PARIS },
    change: { notifyOnSuccess: false },
    expect: { set: { notifyOnSuccess: false } },
  },
  {
    title: 'the budget alone keeps the rest',
    stored: { cronExpr: '0 9 * * 1-5', timezone: PARIS },
    change: { dailyBudgetUsd: 20 },
    expect: { set: { dailyBudgetUsd: 20 } },
  },
  {
    title: 'a time and a new instruction change just those two',
    stored: { cronExpr: '0 9 * * 1-5', timezone: PARIS },
    change: { atTimes: ['10:00'], task: 'Post the weekly summary' },
    expect: { set: { cronExpr: '0 10 * * 1-5', task: 'Post the weekly summary' } },
  },
  // ── the zone ──
  {
    title: 'the zone alone keeps the cron and the rest',
    stored: { cronExpr: '0 9 * * 1-5', timezone: PARIS },
    change: { timezone: 'Asia/Tokyo' },
    expect: { set: { timezone: 'Asia/Tokyo' } },
    toolCannotName: true,
  },
  {
    title: 'a time change keeps the schedule own zone',
    stored: { cronExpr: '0 9 * * 1-5', timezone: 'America/New_York' },
    change: { atTimes: ['10:00'] },
    expect: { set: { cronExpr: '0 10 * * 1-5' } },
  },
  {
    title: 'a legacy schedule without a zone stays without one when its time moves',
    stored: { cronExpr: '0 9 * * 1-5', timezone: null },
    change: { atTimes: ['10:00'] },
    expect: { set: { cronExpr: '0 10 * * 1-5' } },
  },
  // ── the notify channel: named null is "auto", absent is kept ──
  {
    title: 'the notify channel set back to auto is a named change',
    stored: { cronExpr: '0 9 * * 1-5', timezone: PARIS },
    change: { notifyChannel: null },
    expect: { set: { notifyChannel: null } },
    toolCannotName: true,
  },
  // ── refusals that write nothing ──
  {
    title: 'a time and an interval together are refused',
    stored: { cronExpr: '0 9 * * 1-5', timezone: PARIS },
    change: { atTimes: ['10:00'], everyMinutes: 30 },
    expect: { error: /either atTimes OR everyMinutes/ },
  },
  {
    title: 'an empty time list is refused, never ignored',
    stored: { cronExpr: '0 9 * * 1-5', timezone: PARIS },
    change: { atTimes: [], task: 'Post the weekly summary' },
    expect: { error: /at least one time/ },
  },
  {
    title: 'times that do not share a minute are refused',
    stored: { cronExpr: '0 9 * * 1-5', timezone: PARIS },
    change: { atTimes: ['09:00', '13:30'] },
    expect: { error: /share the same minute/ },
  },
  {
    title: 'an empty day list is refused, never read as daily',
    stored: { cronExpr: '0 9 * * 1-5', timezone: PARIS },
    change: { days: [] },
    expect: { error: /at least one day/ },
  },
];
