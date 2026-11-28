// @nodal-agents/adapter-outlook-mail — Graph message payload builders
//
// Graph accepts structured JSON directly in the request body — recipients as
// Recipient[] arrays, attachments as fileAttachment objects with base64
// contentBytes. Unlike Gmail's `raw` RFC 2822 field (adapter-gmail's
// buildRfc2822Message), there is no manual MIME assembly and no header-line
// injection surface to guard against (CRLF in a JSON string field is just
// data, never interpreted as a header line) — this module only turns the
// contract's parsed addresses into Graph's Recipient[] shape, a body of a
// declared type into an ItemBody, and file specs into fileAttachment objects.

import type {
  Recipient,
  Attachment,
  FileAttachment,
  ItemBody,
} from '@microsoft/microsoft-graph-types';
import type { MailAddress, MailBodyFormat } from '@nodal-agents/shared/mail-contract';
import { OutlookAdapterError } from '../errors';

export interface AttachmentSpec {
  /** File name displayed in the email, e.g. 'report.html'. */
  filename: string;
  /** File content — plain string (text encoding) or base64 string (base64 encoding). */
  content: string;
  /** MIME type, e.g. 'text/html'. Inferred from filename if omitted. */
  mimeType?: string;
  /** How `content` is encoded: 'text' (default) or 'base64'. */
  encoding?: 'text' | 'base64';
}

type GraphFileAttachmentPayload = FileAttachment & {
  '@odata.type': '#microsoft.graph.fileAttachment';
};

// Review MINOR-4: Graph's simple fileAttachment (inline contentBytes on the
// message/draft POST or PATCH) caps out at 3 MB of raw content — anything
// larger requires an upload session, which this adapter does not implement.
// Checking here turns an opaque Graph 413 into an explicit, typed adapter
// error before any network call is made.
const OUTGOING_ATTACHMENT_SIZE_CAP_BYTES = 3 * 1024 * 1024;

// MIME type overrides — host-OS independent, same table as adapter-gmail's
// buildRfc2822Message (Windows registry returns non-standard types for
// common extensions).
const MIME_OVERRIDES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

function inferMimeType(filename: string): string {
  const ext = filename.includes('.') ? '.' + filename.split('.').pop()!.toLowerCase() : '';
  return MIME_OVERRIDES[ext] ?? 'application/octet-stream';
}

/**
 * Graph's Recipient[] for contract addresses (parsed by the contract's
 * RFC 5322 address-list parser, display names kept).
 */
export function toGraphRecipients(list: MailAddress[]): Recipient[] {
  return list.map((a) => ({
    emailAddress: a.name ? { name: a.name, address: a.address } : { address: a.address },
  }));
}

/** Graph's ItemBody, of the DECLARED type: never guessed from the content (#1191). */
export function graphBody(content: string, format: MailBodyFormat): ItemBody {
  return { contentType: format, content };
}

/**
 * Build Graph fileAttachment objects (with the required @odata.type
 * discriminator) from the adapter's plain attachment specs.
 */
export function buildFileAttachments(specs: AttachmentSpec[] | undefined): Attachment[] {
  if (!specs?.length) return [];
  return specs.map((spec): GraphFileAttachmentPayload => {
    const rawBytes =
      spec.encoding === 'base64'
        ? Buffer.from(spec.content, 'base64')
        : Buffer.from(spec.content, 'utf-8');

    if (rawBytes.byteLength > OUTGOING_ATTACHMENT_SIZE_CAP_BYTES) {
      throw new OutlookAdapterError(
        'outlook_attachment_too_large',
        `Attachment '${spec.filename}' exceeds the 3 MB inline limit ` +
          `(${Math.round(rawBytes.byteLength / 1024 / 1024)} MB). Graph requires an upload session ` +
          'for larger attachments, which this adapter does not yet support.',
      );
    }

    return {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: spec.filename,
      contentType: spec.mimeType ?? inferMimeType(spec.filename),
      contentBytes: rawBytes.toString('base64'),
    };
  });
}
