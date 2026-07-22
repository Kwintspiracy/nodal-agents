// @nodal-agents/adapter-outlook-mail — message body extraction
//
// Graph's message.body is { contentType: 'text'|'html', content: string } —
// already decoded UTF-8 text. Unlike Gmail (base64url MIME parts requiring
// manual decoding — see adapter-gmail/src/helpers/parse-payload.ts), the only
// work left here is stripping HTML tags when contentType is 'html', so
// downstream tools always return plain, LLM-readable text.

import type { ItemBody } from '@microsoft/microsoft-graph-types';

// Review MINOR-1: cap the RAW body (before any regex work) at a generous
// bound. This is independent of and much larger than BODY_CHAR_CAP (10 000,
// applied downstream by capBody after extraction) — it exists purely to
// bound the input size the regexes below ever have to scan, regardless of
// how large a Graph message body turns out to be.
const RAW_BODY_CHAR_CAP = 200_000;

function stripHtml(html: string): string {
  return (
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/[ \t]+/g, ' ')
      // Review MINOR-1: the original `/\n\s*\n\s*\n/g` was quadratic — `\s`
      // matches `\n` itself, so two adjacent `\s*` groups scanning a long run
      // of newlines have many equivalent ways to split that run between them,
      // and the engine explores all of them. Restricting the "blank line
      // interior" to `[ \t]*` (horizontal whitespace only, never `\n`) removes
      // that ambiguity — each `\n` can only ever be consumed by one specific
      // alternative — making the match linear in input length.
      .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
      .trim()
  );
}

/**
 * Extract plain, human-readable text from a Graph ItemBody. Strips HTML tags
 * when contentType is 'html'; passes plain text through untouched. The raw
 * content is capped at RAW_BODY_CHAR_CAP before any regex work runs (review
 * MINOR-1) — independent of the smaller BODY_CHAR_CAP a caller applies via
 * capBody() afterwards.
 */
export function extractTextFromBody(body: ItemBody | null | undefined): string {
  if (!body?.content) return '';
  const content =
    body.content.length > RAW_BODY_CHAR_CAP
      ? body.content.slice(0, RAW_BODY_CHAR_CAP)
      : body.content;
  if (body.contentType === 'html') return stripHtml(content);
  return content;
}

/**
 * Cap a body string at maxChars, flagging truncation instead of silently
 * cutting it (invariant #4 — fail loud, no silent smart fallback).
 */
export function capBody(text: string, maxChars: number): { body: string; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return { body: trimmed, truncated: false };
  return { body: trimmed.slice(0, maxChars) + '\n\n[...body truncated]', truncated: true };
}
