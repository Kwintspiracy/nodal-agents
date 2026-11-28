// backup-archive.ts — the file a backup is: how it is written, and how it is
// read back. THE ONE reader and writer of the format; `backup.ts` puts a
// database and the state files into it and takes them out again.
//
// WHY A FORMAT OF ITS OWN. A backup holds tables streamed from the database
// (their size is known only once they are read), a few small files, and
// optionally a folder tree. A tar needs each size before the bytes; a zip
// needs its directory at the end and random access to read. Neither ships with
// Node. What does ship is gzip (`node:zlib`), AES-256-GCM and scrypt
// (`node:crypto`), so the format is built from those three and nothing else:
// the same bytes on every operating system, readable by any later version.
//
// THE FILE.
//
//     NODAL-BACKUP\n                      magic, in clear
//     {"nodalBackup":1,...}\n             header, JSON, in clear: version,
//                                         compression, encryption parameters
//     body                                gzip of the records; with a
//                                         passphrase, AES-256-GCM of that gzip
//                                         followed by the 16-byte tag
//
// The two clear lines are the AEAD's additional data: a header changed by a
// single byte fails the tag. Nothing secret is in them.
//
// THE RECORDS, inside the gzip, one after the other:
//
//     u32 length, header JSON             what the record is (kind, names)
//     u32 length > 0, bytes   ...         the payload, in chunks
//     u32 0                               end of the payload
//     u32 length, trailer JSON            bytes, SHA-256 and line count of
//                                         the payload
//
// The last record is `end`, which counts the records before it. A file that
// stops before it, or holds anything after it, is damaged. Every record is
// checked against its trailer as it is read, so a damaged record is named at
// the place it is found.
//
// THE PASSPHRASE. scrypt (N = 2^17, r = 8, p = 1, the cost OWASP recommends)
// turns it into 64 bytes: 32 for AES-256-GCM, 32 for a check value written in
// the header, so a wrong passphrase is refused at once, not at the end of a
// gigabyte. The passphrase is NFC-normalised first: the same characters typed
// on two systems may arrive in two Unicode forms. A forgotten passphrase
// cannot be recovered; the command says so when it writes one.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type Hash,
} from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';
import { once } from 'node:events';
import { pipeline } from 'node:stream';
import { Transform, type Readable, type Writable } from 'node:stream';
import { createGunzip, createGzip, type Gzip } from 'node:zlib';
import { restrictFileToOwner } from '@nodal-agents/shared/state-files';

export const BACKUP_MAGIC = 'NODAL-BACKUP\n';
export const BACKUP_FORMAT_VERSION = 1;

const TAG_BYTES = 16;
const MAX_FRAME_JSON = 4 * 1024 * 1024;
const MAX_CHUNK = 64 * 1024 * 1024;
const MAX_HEADER_LINE = 8 * 1024;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const;
const CHECK_LABEL = 'nodal-backup passphrase check';

// ─── Errors ──────────────────────────────────────────────────────────────────

export type BackupErrorCode =
  | 'BACKUP_NOT_AN_ARCHIVE'
  | 'BACKUP_UNSUPPORTED_VERSION'
  | 'BACKUP_DAMAGED'
  | 'BACKUP_PASSPHRASE_REQUIRED'
  | 'BACKUP_WRONG_PASSPHRASE'
  | 'BACKUP_VERIFY_FAILED'
  | 'BACKUP_SOURCE_UNUSABLE'
  | 'BACKUP_KEY_MISSING'
  | 'BACKUP_KEY_DOES_NOT_OPEN'
  | 'BACKUP_NEWER_THAN_PROGRAM'
  | 'BACKUP_SCHEMA_MISMATCH'
  | 'BACKUP_DESTINATION_EXISTS'
  | 'BACKUP_NOT_PERMITTED'
  | 'BACKUP_FAILED';

/** A backup could not be made, read or restored. The message says why and what was (not) changed. */
export class BackupError extends Error {
  constructor(
    readonly code: BackupErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'BackupError';
  }
}

// ─── What is in a file ───────────────────────────────────────────────────────

export interface BackupEncryption {
  readonly cipher: 'aes-256-gcm';
  readonly kdf: 'scrypt';
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: string;
  readonly iv: string;
  /** HMAC of a fixed label with the second half of the derived bytes. */
  readonly check: string;
}

export interface BackupFileHeader {
  readonly nodalBackup: typeof BACKUP_FORMAT_VERSION;
  readonly compression: 'gzip';
  readonly encryption: BackupEncryption | null;
}

/** The first record: what the archive is a copy of. */
export interface BackupManifest {
  /** The Nodal-Agents version that made it. */
  readonly madeBy: string;
  /** ISO time of the database snapshot it holds. */
  readonly at: string;
  /** The database it was taken from. */
  readonly database: string;
  /** The schema's identity: the `created_at` of every migration applied, and the newest tag. */
  readonly schema: { readonly history: readonly number[]; readonly lastMigration: string | null };
  /** True when the source had the pgvector extension (vector columns), false when they were text. */
  readonly vector: boolean;
  /** True when the home's workspaces folder is inside. */
  readonly workspaces: boolean;
}

export type BackupRecordHeader =
  | { readonly kind: 'manifest'; readonly manifest: BackupManifest }
  | { readonly kind: 'state-file'; readonly name: string }
  | {
      readonly kind: 'table';
      readonly schema: string;
      readonly table: string;
      /** The columns the payload holds, in its order (generated columns are not stored). */
      readonly columns: readonly string[];
      /** Their types, as the source named them (`format_type`). */
      readonly types: readonly string[];
    }
  | { readonly kind: 'sequences' }
  | { readonly kind: 'workspace-dir'; readonly path: string }
  | { readonly kind: 'workspace-file'; readonly path: string }
  | { readonly kind: 'end'; readonly records: number };

/** What a record's payload was, computed while it passed. */
export interface BackupRecordDigest {
  readonly bytes: number;
  readonly sha256: string;
  /** Newline count: one per row for a table (COPY text escapes newlines inside values). */
  readonly lines: number;
}

/** One sequence's position. */
export interface BackupSequence {
  readonly schema: string;
  readonly name: string;
  readonly lastValue: string;
  readonly isCalled: boolean;
}

// ─── Keys ────────────────────────────────────────────────────────────────────

function deriveBytes(
  passphrase: string,
  salt: Buffer,
  enc: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(passphrase.normalize('NFC'), 'utf-8'),
      salt,
      64,
      { N: enc.N, r: enc.r, p: enc.p, maxmem: 256 * enc.N * enc.r + 64 * 1024 * 1024 },
      (err, out) => (err ? reject(err) : resolve(out)),
    );
  });
}

function checkValue(checkKey: Buffer): string {
  return createHmac('sha256', checkKey).update(CHECK_LABEL).digest('base64');
}

async function newEncryption(
  passphrase: string,
): Promise<{ header: BackupEncryption; key: Buffer }> {
  if (passphrase.length === 0) {
    throw new BackupError('BACKUP_FAILED', 'an empty passphrase protects nothing; none was used.');
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const out = await deriveBytes(passphrase, salt, SCRYPT);
  return {
    key: out.subarray(0, 32),
    header: {
      cipher: 'aes-256-gcm',
      kdf: 'scrypt',
      ...SCRYPT,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      check: checkValue(out.subarray(32)),
    },
  };
}

async function keyFor(
  path: string,
  enc: BackupEncryption,
  passphrase: string | undefined,
): Promise<Buffer> {
  if (passphrase === undefined) {
    throw new BackupError(
      'BACKUP_PASSPHRASE_REQUIRED',
      `${path} is protected by a passphrase, and none was given.`,
    );
  }
  const out = await deriveBytes(passphrase, Buffer.from(enc.salt, 'base64'), enc);
  const want = Buffer.from(enc.check, 'base64');
  const got = Buffer.from(checkValue(out.subarray(32)), 'base64');
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    throw new BackupError(
      'BACKUP_WRONG_PASSPHRASE',
      `the passphrase does not open ${path}. Nothing was read from it.`,
    );
  }
  return out.subarray(0, 32);
}

function headerBytes(header: BackupFileHeader): Buffer {
  return Buffer.from(`${BACKUP_MAGIC}${JSON.stringify(header)}\n`, 'utf-8');
}

// ─── Framing ─────────────────────────────────────────────────────────────────

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function countNewlines(buf: Buffer): number {
  let n = 0;
  let i = buf.indexOf(10);
  while (i !== -1) {
    n++;
    i = buf.indexOf(10, i + 1);
  }
  return n;
}

class Digester {
  private readonly hash: Hash = createHash('sha256');
  bytes = 0;
  lines = 0;
  add(buf: Buffer): void {
    this.hash.update(buf);
    this.bytes += buf.length;
    this.lines += countNewlines(buf);
  }
  done(): BackupRecordDigest {
    return { bytes: this.bytes, sha256: this.hash.digest('hex'), lines: this.lines };
  }
}

// ─── Writing ─────────────────────────────────────────────────────────────────

export type BackupPayload = Buffer | string | AsyncIterable<Buffer | string | Uint8Array>;

/**
 * Writes one archive to `path`, a NEW file (exclusive create, owner-only).
 * `record()` appends a record, `finish()` writes the `end` record and flushes
 * the file to disk. On any failure the caller calls `abort()` and removes the
 * file: it never holds an `end` record, so it can never pass for complete.
 */
export class BackupWriter {
  private readonly gzip: Gzip;
  private readonly done: Promise<void>;
  private records = 0;
  private failed: unknown = null;

  private constructor(
    readonly path: string,
    readonly encrypted: boolean,
    key: Buffer | null,
    iv: Buffer | null,
    aad: Buffer,
  ) {
    this.gzip = createGzip();
    const out: Writable = createWriteStream(path, { flags: 'a', flush: true });
    const stages: (Readable | Writable | Transform)[] = [this.gzip];
    if (key !== null && iv !== null) {
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad);
      stages.push(
        new Transform({
          transform(chunk: Buffer, _enc, cb) {
            cb(null, cipher.update(chunk));
          },
          flush(cb) {
            this.push(cipher.final());
            this.push(cipher.getAuthTag());
            cb();
          },
        }),
      );
    }
    stages.push(out);
    this.done = new Promise((resolve, reject) => {
      pipeline(stages as [Readable, ...Writable[]], (err) => {
        if (err) {
          this.failed = err;
          reject(err);
        } else resolve();
      });
    });
    // A failure surfaces through `write`/`finish`; an unobserved rejection
    // here would be reported twice.
    this.done.catch(() => undefined);
  }

  /** Create the file and write its clear header; `passphrase` encrypts the body. */
  static async create(path: string, opts: { passphrase?: string } = {}): Promise<BackupWriter> {
    const enc = opts.passphrase === undefined ? null : await newEncryption(opts.passphrase);
    const header: BackupFileHeader = {
      nodalBackup: BACKUP_FORMAT_VERSION,
      compression: 'gzip',
      encryption: enc?.header ?? null,
    };
    const head = headerBytes(header);
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeSync(fd, head);
    } finally {
      closeSync(fd);
    }
    // Before any byte of the database: a Windows file otherwise inherits its
    // folder's ACL.
    restrictFileToOwner(path);
    return new BackupWriter(
      path,
      enc !== null,
      enc?.key ?? null,
      enc ? Buffer.from(enc.header.iv, 'base64') : null,
      head,
    );
  }

  private async push(buf: Buffer): Promise<void> {
    if (this.failed !== null) throw this.failed;
    if (!this.gzip.write(buf)) {
      await Promise.race([once(this.gzip, 'drain'), this.done]);
    }
    if (this.failed !== null) throw this.failed;
  }

  private async frameJson(value: unknown): Promise<void> {
    const json = Buffer.from(JSON.stringify(value), 'utf-8');
    await this.push(Buffer.concat([u32(json.length), json]));
  }

  /** Append a record; returns what its payload was. */
  async record(header: BackupRecordHeader, payload?: BackupPayload): Promise<BackupRecordDigest> {
    if (header.kind === 'end') throw new Error('the end record is written by finish()');
    await this.frameJson(header);
    const digest = new Digester();
    const chunk = async (piece: Buffer): Promise<void> => {
      for (let at = 0; at < piece.length; at += MAX_CHUNK) {
        const part = piece.subarray(at, Math.min(piece.length, at + MAX_CHUNK));
        digest.add(part);
        await this.push(Buffer.concat([u32(part.length), part]));
      }
    };
    if (typeof payload === 'string') await chunk(Buffer.from(payload, 'utf-8'));
    else if (Buffer.isBuffer(payload)) await chunk(payload);
    else if (payload !== undefined) {
      for await (const piece of payload) {
        const buf = typeof piece === 'string' ? Buffer.from(piece, 'utf-8') : Buffer.from(piece);
        if (buf.length > 0) await chunk(buf);
      }
    }
    await this.push(u32(0));
    const result = digest.done();
    await this.frameJson(result);
    this.records++;
    return result;
  }

  /** Write the `end` record, close the compression (and the cipher), flush the file to disk. */
  async finish(): Promise<void> {
    await this.frameJson({ kind: 'end', records: this.records } satisfies BackupRecordHeader);
    await this.push(u32(0));
    await this.frameJson(new Digester().done());
    this.gzip.end();
    await this.done;
  }

  /** Stop writing; the caller removes the file. */
  async abort(): Promise<void> {
    this.gzip.destroy();
    await this.done.catch(() => undefined);
  }
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** The clear header of the file at `path`, and where its body starts. */
export function readBackupHeader(path: string): {
  header: BackupFileHeader;
  bodyStart: number;
  raw: Buffer;
} {
  const fd = openSync(path, 'r');
  let head: Buffer;
  try {
    const buf = Buffer.alloc(MAX_HEADER_LINE);
    const n = readSync(fd, buf, 0, buf.length, 0);
    head = buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
  const magic = Buffer.from(BACKUP_MAGIC, 'utf-8');
  if (head.length < magic.length || !head.subarray(0, magic.length).equals(magic)) {
    throw new BackupError('BACKUP_NOT_AN_ARCHIVE', `${path} is not a Nodal-Agents backup.`);
  }
  const end = head.indexOf(10, magic.length);
  if (end === -1) {
    throw new BackupError('BACKUP_DAMAGED', `${path}: its header is cut short.`);
  }
  let header: BackupFileHeader;
  try {
    header = JSON.parse(head.subarray(magic.length, end).toString('utf-8')) as BackupFileHeader;
  } catch (err) {
    throw new BackupError('BACKUP_DAMAGED', `${path}: its header is not readable.`, { cause: err });
  }
  if (header.nodalBackup !== BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      'BACKUP_UNSUPPORTED_VERSION',
      `${path} is a backup of format ${String(header.nodalBackup)}; this program reads format ` +
        `${BACKUP_FORMAT_VERSION}. Restore it with a newer version of Nodal-Agents.`,
    );
  }
  if (header.compression !== 'gzip') {
    throw new BackupError(
      'BACKUP_DAMAGED',
      `${path}: unknown compression "${String(header.compression)}".`,
    );
  }
  const enc = header.encryption;
  if (enc !== null && (enc.cipher !== 'aes-256-gcm' || enc.kdf !== 'scrypt')) {
    throw new BackupError('BACKUP_UNSUPPORTED_VERSION', `${path}: unknown encryption.`);
  }
  return { header, bodyStart: end + 1, raw: head.subarray(0, end + 1) };
}

/** AES-256-GCM decryption that holds back the last 16 bytes: the tag. */
function gcmDecipher(key: Buffer, iv: Buffer, aad: Buffer, path: string): Transform {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  let tail: Buffer = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const all = tail.length === 0 ? chunk : Buffer.concat([tail, chunk]);
      if (all.length <= TAG_BYTES) {
        tail = all;
        cb();
        return;
      }
      tail = Buffer.from(all.subarray(all.length - TAG_BYTES));
      cb(null, decipher.update(all.subarray(0, all.length - TAG_BYTES)));
    },
    flush(cb) {
      if (tail.length !== TAG_BYTES) {
        cb(new BackupError('BACKUP_DAMAGED', `${path} is cut short.`));
        return;
      }
      try {
        decipher.setAuthTag(tail);
        cb(null, decipher.final());
      } catch (err) {
        cb(
          new BackupError(
            'BACKUP_DAMAGED',
            `${path} does not authenticate: it was changed or damaged after it was written.`,
            { cause: err },
          ),
        );
      }
    },
  });
}

/** Exact-length reads over a stream of chunks. */
class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;
  constructor(private readonly source: AsyncIterator<Buffer>) {}

  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.ended) {
      const next = await this.source.next();
      if (next.done === true) this.ended = true;
      else this.buf = this.buf.length === 0 ? next.value : Buffer.concat([this.buf, next.value]);
    }
    return this.buf.length >= n;
  }

  /** `n` bytes, or null when the stream ended before them. */
  async read(n: number): Promise<Buffer | null> {
    if (!(await this.fill(n))) return null;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** True when nothing is left. */
  async atEnd(): Promise<boolean> {
    return !(await this.fill(1));
  }
}

/**
 * Reads one archive, record by record. `next()` gives the next record's
 * header; its payload is read with `payload()` (or skipped by the next
 * `next()`), and checked against its trailer as it ends. After the `end`
 * record, `next()` returns null once it has proved nothing follows and, for
 * an encrypted file, that the tag authenticates.
 */
export class BackupReader {
  private records = 0;
  private pendingPayload = false;
  private finished = false;

  private constructor(
    readonly path: string,
    readonly header: BackupFileHeader,
    private readonly reader: ByteReader,
    private readonly stream: Readable,
  ) {}

  static async open(path: string, opts: { passphrase?: string } = {}): Promise<BackupReader> {
    const { header, bodyStart, raw } = readBackupHeader(path);
    const key =
      header.encryption === null ? null : await keyFor(path, header.encryption, opts.passphrase);
    const body = createReadStream(path, { start: bodyStart });
    const gunzip = createGunzip();
    const stages: (Readable | Transform | Writable)[] = [body];
    if (key !== null && header.encryption !== null) {
      stages.push(gcmDecipher(key, Buffer.from(header.encryption.iv, 'base64'), raw, path));
    }
    stages.push(gunzip);
    const last = pipeline(
      stages as [Readable, ...Writable[]],
      () => undefined,
    ) as unknown as Readable;
    return new BackupReader(
      path,
      header,
      new ByteReader(last[Symbol.asyncIterator]() as AsyncIterator<Buffer>),
      last,
    );
  }

  private damaged(what: string, cause?: unknown): BackupError {
    return new BackupError(
      'BACKUP_DAMAGED',
      `${this.path}: ${what}.`,
      cause === undefined ? undefined : { cause },
    );
  }

  private async u32(what: string): Promise<number> {
    let b: Buffer | null;
    try {
      b = await this.reader.read(4);
    } catch (err) {
      throw err instanceof BackupError ? err : this.damaged(`unreadable ${what}`, err);
    }
    if (b === null) throw this.damaged(`cut short at ${what}`);
    return b.readUInt32BE(0);
  }

  private async json<T>(what: string): Promise<T> {
    const n = await this.u32(what);
    if (n > MAX_FRAME_JSON) throw this.damaged(`${what} of ${n} bytes`);
    const b = await this.reader.read(n).catch((err: unknown) => {
      throw err instanceof BackupError ? err : this.damaged(`unreadable ${what}`, err);
    });
    if (b === null) throw this.damaged(`cut short in ${what}`);
    try {
      return JSON.parse(b.toString('utf-8')) as T;
    } catch (err) {
      throw this.damaged(`${what} is not readable`, err);
    }
  }

  /** The next record's header, or null after the `end` record. */
  async next(): Promise<BackupRecordHeader | null> {
    if (this.finished) return null;
    if (this.pendingPayload) {
      for await (const chunk of this.payload()) void chunk;
    }
    const header = await this.json<BackupRecordHeader>('record header');
    if (header.kind === 'end') {
      for await (const chunk of this.chunks()) void chunk;
      await this.json<BackupRecordDigest>('record trailer');
      if (header.records !== this.records) {
        throw this.damaged(`it announces ${header.records} records and holds ${this.records}`);
      }
      let atEnd: boolean;
      try {
        atEnd = await this.reader.atEnd();
      } catch (err) {
        throw err instanceof BackupError ? err : this.damaged('unreadable after its end', err);
      }
      if (!atEnd) throw this.damaged('it holds bytes after its end record');
      this.finished = true;
      return null;
    }
    this.records++;
    this.pendingPayload = true;
    return header;
  }

  private async *chunks(): AsyncGenerator<Buffer> {
    for (;;) {
      const n = await this.u32('chunk length');
      if (n === 0) return;
      if (n > MAX_CHUNK) throw this.damaged(`a chunk of ${n} bytes`);
      const b = await this.reader.read(n).catch((err: unknown) => {
        throw err instanceof BackupError ? err : this.damaged('unreadable chunk', err);
      });
      if (b === null) throw this.damaged('cut short in a payload');
      yield b;
    }
  }

  /**
   * The current record's payload. Once it ends, the bytes read are compared
   * with the record's trailer; a difference throws, naming the record.
   * `sink.digest` (when given) receives what was read.
   */
  async *payload(sink?: { digest?: BackupRecordDigest }): AsyncGenerator<Buffer> {
    if (!this.pendingPayload) return;
    this.pendingPayload = false;
    const d = new Digester();
    for await (const chunk of this.chunks()) {
      d.add(chunk);
      yield chunk;
    }
    const got = d.done();
    const want = await this.json<BackupRecordDigest>('record trailer');
    if (want.bytes !== got.bytes || want.sha256 !== got.sha256 || want.lines !== got.lines) {
      throw this.damaged(
        `record ${this.records} does not match its own check (${got.bytes} bytes read, ${want.bytes} written)`,
      );
    }
    if (sink !== undefined) sink.digest = got;
  }

  /** Read the current payload whole (state files, the sequences). */
  async payloadBytes(): Promise<{ bytes: Buffer; digest: BackupRecordDigest }> {
    const parts: Buffer[] = [];
    const sink: { digest?: BackupRecordDigest } = {};
    for await (const chunk of this.payload(sink)) parts.push(chunk);
    return { bytes: Buffer.concat(parts), digest: sink.digest ?? new Digester().done() };
  }

  close(): void {
    this.stream.destroy();
  }
}
