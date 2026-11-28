// @nodal-agents/adapter-gmail — the mail contract's conformance suite, run on Gmail.
//
// The real tools run against googleapis' real Gmail client, whose HTTP layer
// (gaxios' fetch) is replaced by a fake Gmail server holding the contract's
// fixture mailbox. What Gmail would receive — the `raw` RFC 5322 message — is
// decoded with postal-mime (a maintained MIME parser) and a small part walker,
// and handed to the shared assertions.

import { describe } from 'vitest';
import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import PostalMime from 'postal-mime';
import MailComposer from 'nodemailer/lib/mail-composer';
import {
  MAIL_CONTRACT_OWNER,
  runMailContractSuite,
} from '@nodal-agents/test-kit/mail-contract-suite';
import type {
  MailContractDriver,
  MailContractOperation,
  MailFixtureAddress,
  MailFixtureMessage,
  MailOutgoing,
  MailRunOptions,
} from '@nodal-agents/test-kit/mail-contract-suite';
import {
  createForwardMessageTool,
  createReplyMessageTool,
  createSendEmailTool,
} from '../tools/messages';

// ── The stored form of a fixture message ────────────────────────────────────

function headerAddress(list: MailFixtureAddress[] | undefined): string {
  return (list ?? [])
    .map((a) => (a.name ? `"${a.name.replace(/"/g, '\\"')}" <${a.address}>` : a.address))
    .join(', ');
}

const storedCache = new Map<string, Buffer>();

/** The bytes Gmail stores for a fixture (what `format: 'raw'` returns). */
async function storedMessage(m: MailFixtureMessage): Promise<Buffer> {
  const cached = storedCache.get(m.id);
  if (cached) return cached;
  const node = new MailComposer({
    from: headerAddress(m.from),
    to: headerAddress(m.to),
    ...(m.cc ? { cc: headerAddress(m.cc) } : {}),
    ...(m.replyTo ? { replyTo: headerAddress(m.replyTo) } : {}),
    subject: m.subject,
    messageId: m.messageIdHeader,
    ...(m.references ? { references: m.references } : {}),
    date: new Date('2026-11-20T10:00:00Z'),
    text: m.text,
    ...(m.html ? { html: m.html } : {}),
    attachments: (m.files ?? []).map((f) => ({
      filename: f.filename,
      contentType: f.mimeType,
      content: f.content,
      ...(f.inline ? { cid: f.contentId, contentDisposition: 'inline' as const } : {}),
    })),
  }).compile();
  const bytes = await node.build();
  storedCache.set(m.id, bytes);
  return bytes;
}

/** Gmail's `full` payload for a fixture: headers and a part tree with named files. */
function payloadOf(m: MailFixtureMessage): gmail_v1.Schema$MessagePart {
  const h = (name: string, value: string | undefined) =>
    value ? [{ name, value }] : ([] as gmail_v1.Schema$MessagePartHeader[]);
  const headers = [
    ...h('From', headerAddress(m.from)),
    ...h('Reply-To', m.replyTo ? headerAddress(m.replyTo) : undefined),
    ...h('To', headerAddress(m.to)),
    ...h('Cc', m.cc ? headerAddress(m.cc) : undefined),
    ...h('Subject', m.subject),
    ...h('Message-ID', m.messageIdHeader),
    ...h('References', m.references?.join(' ')),
  ];
  const parts: gmail_v1.Schema$MessagePart[] = [
    {
      mimeType: 'text/plain',
      filename: '',
      body: { data: Buffer.from(m.text).toString('base64url') },
    },
    ...(m.html
      ? [
          {
            mimeType: 'text/html',
            filename: '',
            body: { data: Buffer.from(m.html).toString('base64url') },
          },
        ]
      : []),
    ...(m.files ?? []).map((f, i) => ({
      mimeType: f.mimeType,
      filename: f.filename,
      headers: [
        {
          name: 'Content-Disposition',
          value: `${f.inline ? 'inline' : 'attachment'}; filename="${f.filename}"`,
        },
        ...(f.contentId ? [{ name: 'Content-ID', value: `<${f.contentId}>` }] : []),
      ],
      body: { attachmentId: `att-${i}`, size: f.content.length },
    })),
  ];
  return { mimeType: 'multipart/mixed', filename: '', headers, parts };
}

// ── Decoding what Gmail would receive ───────────────────────────────────────

interface WalkedPart {
  contentType: string;
  disposition: string;
}

/** Leaf parts of a MIME message (enough structure to count body parts). */
function walkParts(raw: string): WalkedPart[] {
  const sep = raw.search(/\r?\n\r?\n/);
  const headerBlock = (sep === -1 ? raw : raw.slice(0, sep)).replace(/\r?\n[ \t]+/g, ' ');
  const body = sep === -1 ? '' : raw.slice(sep).replace(/^\r?\n\r?\n/, '');
  const header = (name: string) =>
    headerBlock
      .split(/\r?\n/)
      .find((l) => l.toLowerCase().startsWith(name + ':'))
      ?.slice(name.length + 1)
      .trim() ?? '';
  const contentType = header('content-type') || 'text/plain';
  const disposition = header('content-disposition');
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (type.startsWith('multipart/')) {
    const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
    if (!boundary) return [];
    const chunks = body.split(`--${boundary}`).slice(1);
    return chunks
      .filter((c) => !c.startsWith('--'))
      .flatMap((c) => walkParts(c.replace(/^\r?\n/, '')));
  }
  return [{ contentType: type, disposition: disposition.toLowerCase() }];
}

function addressesOf(list: Array<{ name?: string; address?: string }> | undefined) {
  return (list ?? []).map((a) =>
    a.name ? { name: a.name, address: a.address ?? '' } : { address: a.address ?? '' },
  );
}

async function decodeOutgoing(
  raw: string,
  threadId: string | null,
  mailbox: MailFixtureMessage[],
): Promise<MailOutgoing> {
  const bytes = Buffer.from(raw, 'base64url');
  const email = await PostalMime.parse(bytes, { rfc822Attachments: true });
  const leaves = walkParts(bytes.toString('latin1')).filter(
    (p) => !p.disposition.startsWith('attachment'),
  );
  const bodyParts = leaves.filter(
    (p) => p.contentType === 'text/plain' || p.contentType === 'text/html',
  );
  const format = bodyParts[0]?.contentType === 'text/html' ? 'html' : 'text';
  const attachments = email.attachments.map((a) => ({
    filename: a.filename ?? '',
    mimeType: a.mimeType,
    content: Buffer.from(a.content as ArrayBuffer),
  }));
  const rfc822 = attachments.find((a) => a.mimeType === 'message/rfc822');
  let forwardedOriginal: MailOutgoing['forwardedOriginal'] = null;
  if (rfc822) {
    // Which stored message do these bytes carry?
    for (const m of mailbox) {
      if ((await storedMessage(m)).equals(rfc822.content)) {
        forwardedOriginal = { messageId: m.id, content: rfc822.content };
      }
    }
    forwardedOriginal ??= { messageId: '(unknown bytes)', content: rfc822.content };
  }
  return {
    to: addressesOf(email.to),
    cc: addressesOf(email.cc),
    bcc: addressesOf(email.bcc),
    subject: email.subject ?? '',
    body: { format, content: format === 'html' ? (email.html ?? '') : (email.text ?? '') },
    bodyPartCount: bodyParts.length,
    threadId,
    inReplyTo: email.inReplyTo ?? null,
    attachments: attachments.filter((a) => a.mimeType !== 'message/rfc822'),
    forwardedOriginal,
  };
}

// ── The fake Gmail server, at gaxios' fetch ─────────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeGmail(
  mailbox: MailFixtureMessage[],
  options: MailRunOptions | undefined,
  sent: Array<{ raw: string; threadId: string | null }>,
): gmail_v1.Gmail {
  const fetchImplementation = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;

    if (method === 'GET' && path.endsWith('/users/me/settings/sendAs')) {
      return json(200, {
        sendAs: [{ sendAsEmail: MAIL_CONTRACT_OWNER.address, isPrimary: true }],
      });
    }
    const get = /\/users\/me\/messages\/([^/]+)$/.exec(path);
    if (method === 'GET' && get) {
      const m = mailbox.find((x) => x.id === decodeURIComponent(get[1]!));
      if (!m) return json(404, { error: { code: 404, message: 'Not Found' } });
      const format = url.searchParams.get('format');
      if (format === 'raw') {
        return json(200, {
          id: m.id,
          threadId: m.threadId,
          raw: (await storedMessage(m)).toString('base64url'),
        });
      }
      const payload = payloadOf(m);
      if (format === 'metadata') {
        const wanted = url.searchParams.getAll('metadataHeaders').map((x) => x.toLowerCase());
        payload.headers = (payload.headers ?? []).filter((x) =>
          wanted.includes((x.name ?? '').toLowerCase()),
        );
        delete payload.parts;
      }
      return json(200, { id: m.id, threadId: m.threadId, payload });
    }
    if (method === 'POST' && path.endsWith('/users/me/messages/send')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { raw: string; threadId?: string };
      sent.push({ raw: body.raw, threadId: body.threadId ?? null });
      if (options?.providerRefuses === 'message-too-large') {
        return json(400, {
          error: { code: 400, message: 'Request payload size exceeds the limit' },
        });
      }
      return json(200, { id: `sent-${sent.length}`, threadId: body.threadId ?? 'new-thread' });
    }
    return json(501, { error: { code: 501, message: `fake Gmail: no route ${method} ${path}` } });
  };

  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: 'test-token', expiry_date: Date.now() + 3_600_000 });
  return google.gmail({ version: 'v1', auth, fetchImplementation });
}

// ── The driver ──────────────────────────────────────────────────────────────

const gmailDriver: MailContractDriver = {
  provider: 'gmail',
  owner: MAIL_CONTRACT_OWNER,
  storedBytes: (m) => storedCache.get(m.id) ?? null,
  async run(op: MailContractOperation, mailbox, options) {
    await Promise.all(mailbox.map(storedMessage));
    const sent: Array<{ raw: string; threadId: string | null }> = [];
    const gmail = makeGmail(mailbox, options, sent);
    let result: unknown;
    if (op.kind === 'send') {
      const tool = createSendEmailTool(gmail);
      result = await tool.execute(
        tool.inputSchema.parse({
          to: op.to,
          cc: op.cc,
          bcc: op.bcc,
          subject: op.subject,
          body: op.body,
          body_format: op.bodyFormat,
        }),
        {} as never,
      );
    } else if (op.kind === 'reply') {
      const tool = createReplyMessageTool(gmail);
      result = await tool.execute(
        tool.inputSchema.parse({
          message_id: op.messageId,
          body: op.body,
          body_format: op.bodyFormat,
          reply_all: op.replyAll,
        }),
        {} as never,
      );
    } else {
      const tool = createForwardMessageTool(gmail);
      result = await tool.execute(
        tool.inputSchema.parse({ message_id: op.messageId, to: op.to, note: op.note }),
        {} as never,
      );
    }
    const outgoing = await Promise.all(sent.map((s) => decodeOutgoing(s.raw, s.threadId, mailbox)));
    return { result, outgoing };
  },
};

describe('Gmail @cap:connecter-un-service/moteur', () => {
  runMailContractSuite(gmailDriver);
});
