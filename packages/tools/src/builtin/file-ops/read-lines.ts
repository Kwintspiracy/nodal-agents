// file-ops/read-lines.ts — bounded-memory windowed line read for files too
// large to safely load whole into a string (see workspace.ts MAX_READ_BYTES /
// MAX_READ_FILE_BYTES). Streams the file in fixed-size chunks and splits
// lines manually instead of node:readline, which strips trailing '\r' and
// never emits the final empty line after a trailing '\n' — both of which
// would break parity with `raw.split('\n')`, the semantics every
// file_read/skill_file_read caller relies on today for small files.
//
// PARITY CONTRACT with `content.split('\n')`:
//   - a trailing '\n' produces one extra, empty final line
//   - '\r' is never stripped — CRLF line endings keep their trailing '\r'
//   - an empty file produces exactly one line: ['']
// Memory stays bounded by: one chunk, the tail of whatever line straddles two
// chunks, and the lines that actually fall inside [startIdx, endIdxCeiling) —
// never the full line array or the full file content.

import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/** Default chunk size fed to the decoder per read. Exported for testability. */
export const DEFAULT_CHUNK_BYTES = 256 * 1024;

export interface WindowedLinesResult {
  /** Lines with 0-based index in [startIdx, endIdxCeiling) that exist in the file. */
  windowLines: string[];
  /** Total number of lines in the file — identical to `content.split('\n').length`. */
  totalLines: number;
}

/**
 * Thrown when `maxBytes` is exceeded mid-read — i.e. the file grew past the
 * caller's cap AFTER the pre-flight `stat()` that authorized this read (a
 * TOCTOU: another job writing into a SHARED workspace can append to the file
 * between the size check and the stream completing). The stream is destroyed
 * as soon as this is detected so no unbounded amount of data accumulates in
 * `partial`.
 */
export class ReadLinesCapExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadLinesCapExceededError';
  }
}

/**
 * Stream `path` and collect only the lines whose 0-based index falls inside
 * [startIdx, endIdxCeiling), returning them alongside the total line count.
 * Never materializes the full line array or the full file content in memory.
 *
 * `chunkBytes` is exposed for tests that want a small, deterministic chunk
 * size to force a multi-byte UTF-8 character across a chunk boundary without
 * needing a multi-hundred-KB fixture file.
 *
 * `maxBytes`, when provided, bounds the RAW bytes actually read from the
 * stream (counted from `chunk.length`, before decoding) — independent of
 * whatever size the caller observed via `stat()` before calling this. This
 * is a defense-in-depth guard, not the primary cap: callers are expected to
 * `stat()` first and refuse oversized files outright, but the check-then-read
 * gap is real on a shared, concurrently-written workspace, and without an
 * internal cap `partial`/`windowLines` could otherwise grow unbounded for as
 * long as the stream keeps producing data.
 */
export async function readLinesWindowed(
  path: string,
  startIdx: number,
  endIdxCeiling: number,
  chunkBytes: number = DEFAULT_CHUNK_BYTES,
  maxBytes?: number,
): Promise<WindowedLinesResult> {
  const decoder = new StringDecoder('utf8');
  const windowLines: string[] = [];
  let lineIdx = 0;
  let partial = '';
  let bytesRead = 0;
  let aborted = false;

  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path, { highWaterMark: chunkBytes });
    stream.on('data', (chunk: Buffer) => {
      if (aborted) return;
      bytesRead += chunk.length;
      if (maxBytes !== undefined && bytesRead > maxBytes) {
        aborted = true;
        stream.destroy();
        reject(
          new ReadLinesCapExceededError(
            `File grew past ${maxBytes} bytes while it was being read (read ${bytesRead} bytes so ` +
              `far) — aborting. It likely changed size after being checked; retry the read.`,
          ),
        );
        return;
      }
      // decoder.write() buffers any dangling multi-byte sequence internally
      // and only returns fully-decoded characters — so a character split
      // across this chunk and the next decodes correctly either way.
      const text = partial + decoder.write(chunk);
      const parts = text.split('\n');
      partial = parts.pop() ?? '';
      for (const line of parts) {
        if (lineIdx >= startIdx && lineIdx < endIdxCeiling) windowLines.push(line);
        lineIdx++;
      }
    });
    stream.on('end', () => {
      if (aborted) return;
      partial += decoder.end();
      // The tail after the last '\n' (or the whole file, if it has none) is
      // always its own line — this is what gives an empty file exactly one
      // line and a trailing '\n' its extra empty final line.
      if (lineIdx >= startIdx && lineIdx < endIdxCeiling) windowLines.push(partial);
      lineIdx++;
      resolvePromise();
    });
    stream.on('error', (err) => {
      if (aborted) return;
      reject(err);
    });
  });

  return { windowLines, totalLines: lineIdx };
}
