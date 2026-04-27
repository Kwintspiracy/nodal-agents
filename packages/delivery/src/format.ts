// format.ts — formatJobResult: builds message chunks for delivery channels

import type { FormatOpts } from './types.ts';

const DEFAULT_MAX_LENGTH = 4000;

export interface FormatJobInput {
  id: string;
  task: string;
  result: string | null;
  error: string | null;
  channel?: string | null;
}

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 * Telegram HTML supports: <b>, <i>, <code>, <pre>, <a href="..."> — and requires
 * <, >, & to be escaped in all text outside those tags.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the full message string from a job row.
 * Uses HTML parse mode (escape <>&) — simpler than MarkdownV2 escaping.
 */
function buildMessage(job: FormatJobInput, includeJobId: boolean): string {
  const title = escapeHtml(job.task.trim());
  const body = job.result ?? job.error ?? '';
  const footer = includeJobId ? `\n\nJob: ${job.id}` : '';
  return `<b>${title}</b>\n\n${escapeHtml(body)}${footer}`;
}

/**
 * Split a string into chunks of at most maxLength chars.
 * Prefers splitting at newlines; falls back to word boundaries; hard-splits at maxLength.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Try to split at last newline within maxLength
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) {
      // Fall back to last space within maxLength
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= 0) {
      // Hard split
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

/**
 * Format a job result into one or more message chunks.
 *
 * Returns an array: single chunk if under maxLength, multiple if longer.
 * The HTML parse mode is used — callers should pass parseMode: 'HTML' to Telegram.
 */
export function formatJobResult(job: FormatJobInput, opts?: FormatOpts): string[] {
  const maxLength = opts?.maxLength ?? DEFAULT_MAX_LENGTH;
  const includeJobId = opts?.includeJobId ?? true;

  const message = buildMessage(job, includeJobId);
  return splitMessage(message, maxLength);
}
