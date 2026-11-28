// @nodal-agents/adapter-outlook-mail — the mail contract's conformance suite, run on Outlook.
//
// The real tools run against the real Microsoft Graph client, whose HTTP layer
// is replaced by a fake Graph server: the SDK's documented extension point is
// its middleware chain, and the fake is the chain's last link, where the
// SDK's own HTTPMessageHandler would call fetch. What Graph would receive (the
// JSON of each request) is decoded into the neutral shape the shared
// assertions read.

import { describe } from 'vitest';
import { Client } from '@microsoft/microsoft-graph-client';
import type { Context, Middleware } from '@microsoft/microsoft-graph-client';
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

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

interface GraphBody {
  contentType?: string;
  content?: string;
}

function recipients(list: MailFixtureAddress[] | undefined): GraphRecipient[] {
  return (list ?? []).map((a) => ({
    emailAddress: { ...(a.name ? { name: a.name } : {}), address: a.address },
  }));
}

function fromRecipients(list: GraphRecipient[] | undefined): MailFixtureAddress[] {
  return (list ?? []).map((r) =>
    r.emailAddress?.name
      ? { name: r.emailAddress.name, address: r.emailAddress.address ?? '' }
      : { address: r.emailAddress?.address ?? '' },
  );
}

function graphMessage(m: MailFixtureMessage) {
  return {
    id: m.id,
    conversationId: m.threadId,
    internetMessageId: m.messageIdHeader,
    subject: m.subject,
    from: recipients(m.from)[0],
    sender: recipients(m.from)[0],
    replyTo: recipients(m.replyTo),
    toRecipients: recipients(m.to),
    ccRecipients: recipients(m.cc),
    hasAttachments: (m.files ?? []).length > 0,
    body: m.html
      ? { contentType: 'html', content: m.html }
      : { contentType: 'text', content: m.text },
  };
}

interface Draft {
  id: string;
  kind: 'reply' | 'forward';
  original: MailFixtureMessage;
  subject: string;
  toRecipients: GraphRecipient[];
  ccRecipients: GraphRecipient[];
  body: GraphBody;
  comment: string | null;
  /** The forward's body (which holds the original) was replaced by the client. */
  bodyReplaced: boolean;
  attachments: Array<{ name?: string; contentType?: string; contentBytes?: string }>;
}

function body(status: number, payload?: unknown): Response {
  return payload === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
}

/** The last link of the Graph SDK's middleware chain: a fake Graph server. */
class FakeGraph implements Middleware {
  readonly outgoing: MailOutgoing[] = [];
  private readonly drafts = new Map<string, Draft>();

  constructor(
    private readonly mailbox: MailFixtureMessage[],
    private readonly options: MailRunOptions | undefined,
  ) {}

  setNext(): void {}

  async execute(context: Context): Promise<void> {
    const url = new URL(
      typeof context.request === 'string' ? context.request : context.request.url,
    );
    const method = (context.options?.method ?? 'GET').toUpperCase();
    const raw = context.options?.body;
    const payload = (typeof raw === 'string' && raw.length > 0 ? JSON.parse(raw) : {}) as Record<
      string,
      unknown
    >;
    context.response = this.route(method, url.pathname, payload);
  }

  private refused(): Response | null {
    return this.options?.providerRefuses === 'message-too-large'
      ? body(413, {
          error: {
            code: 'ErrorMessageSizeExceeded',
            message: 'The message exceeds the maximum supported size.',
          },
        })
      : null;
  }

  private route(method: string, path: string, payload: Record<string, unknown>): Response {
    if (method === 'GET' && path === '/oidc/userinfo') {
      return body(200, {
        sub: 'subject-id',
        email: MAIL_CONTRACT_OWNER.address,
        preferred_username: MAIL_CONTRACT_OWNER.address,
      });
    }
    if (method === 'POST' && path === '/v1.0/me/sendMail') {
      const message = payload['message'] as {
        subject?: string;
        body?: GraphBody;
        toRecipients?: GraphRecipient[];
        ccRecipients?: GraphRecipient[];
        bccRecipients?: GraphRecipient[];
        attachments?: Draft['attachments'];
      };
      const refused = this.refused();
      if (refused) return refused;
      this.outgoing.push({
        to: fromRecipients(message.toRecipients),
        cc: fromRecipients(message.ccRecipients),
        bcc: fromRecipients(message.bccRecipients),
        subject: message.subject ?? '',
        body: {
          format: message.body?.contentType === 'html' ? 'html' : 'text',
          content: message.body?.content ?? '',
        },
        bodyPartCount: message.body ? 1 : 0,
        threadId: null,
        inReplyTo: null,
        attachments: (message.attachments ?? []).map((a) => ({
          filename: a.name ?? '',
          mimeType: a.contentType ?? '',
          content: Buffer.from(a.contentBytes ?? '', 'base64'),
        })),
        forwardedOriginal: null,
      });
      return body(202);
    }

    const m = /^\/v1\.0\/me\/messages\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (!m) return body(501, { error: { code: 'fake', message: `no route ${method} ${path}` } });
    const id = decodeURIComponent(m[1]!);
    const action = m[2];
    const draft = this.drafts.get(id);
    const original = this.mailbox.find((x) => x.id === id);

    if (!draft && !original) {
      return body(404, { error: { code: 'ErrorItemNotFound', message: 'Not found' } });
    }

    if (original) {
      if (method === 'GET' && action === undefined) return body(200, graphMessage(original));
      if (method === 'GET' && action === 'attachments') {
        return body(200, {
          value: (original.files ?? []).map((f, i) => ({
            id: `att-${i}`,
            name: f.filename,
            contentType: f.mimeType,
            isInline: f.inline,
            size: f.content.length,
          })),
        });
      }
      if (method === 'POST' && (action === 'createReply' || action === 'createForward')) {
        // Graph's draft: the reply addressed to the original's sender, the
        // forward to nobody yet; threading is Graph's.
        const d: Draft = {
          id: `draft-${this.drafts.size + 1}`,
          kind: action === 'createReply' ? 'reply' : 'forward',
          original,
          subject: `${action === 'createReply' ? 'RE' : 'FW'}: ${original.subject}`,
          toRecipients: action === 'createReply' ? recipients(original.from) : [],
          ccRecipients: [],
          body: { contentType: 'html', content: '<div>quoted original</div>' },
          comment: typeof payload['comment'] === 'string' ? (payload['comment'] as string) : null,
          bodyReplaced: false,
          attachments: [],
        };
        this.drafts.set(d.id, d);
        return body(201, {
          id: d.id,
          conversationId: original.threadId,
          subject: d.subject,
          toRecipients: d.toRecipients,
        });
      }
      if (
        method === 'POST' &&
        (action === 'reply' || action === 'replyAll' || action === 'forward')
      ) {
        // The one-call actions, as Graph documents them: reply "uses the
        // sender of the original message as recipient".
        const refused = action === 'forward' ? this.refused() : null;
        if (refused) return refused;
        const msg = (payload['message'] ?? {}) as {
          toRecipients?: GraphRecipient[];
          ccRecipients?: GraphRecipient[];
          body?: GraphBody;
        };
        const comment =
          typeof payload['comment'] === 'string' ? (payload['comment'] as string) : '';
        const owner = MAIL_CONTRACT_OWNER.address;
        const to =
          action === 'forward'
            ? fromRecipients(payload['toRecipients'] as GraphRecipient[])
            : [...original.from, ...fromRecipients(msg.toRecipients)];
        const cc =
          action === 'replyAll'
            ? [...original.to, ...(original.cc ?? [])].filter((a) => a.address !== owner)
            : fromRecipients(msg.ccRecipients);
        this.outgoing.push({
          to,
          cc,
          bcc: [],
          subject: null,
          body: msg.body
            ? {
                format: msg.body.contentType === 'html' ? 'html' : 'text',
                content: msg.body.content ?? '',
              }
            : { format: 'html', content: comment },
          bodyPartCount: 1,
          threadId: action === 'forward' ? null : original.threadId,
          inReplyTo: action === 'forward' ? null : original.messageIdHeader,
          attachments: [],
          forwardedOriginal:
            action === 'forward' ? { messageId: original.id, content: null } : null,
        });
        return body(202);
      }
    }

    if (draft) {
      if (method === 'PATCH' && action === undefined) {
        if (typeof payload['subject'] === 'string') draft.subject = payload['subject'] as string;
        if (payload['toRecipients'])
          draft.toRecipients = payload['toRecipients'] as GraphRecipient[];
        if (payload['ccRecipients'])
          draft.ccRecipients = payload['ccRecipients'] as GraphRecipient[];
        if (payload['body']) {
          draft.body = payload['body'] as GraphBody;
          draft.comment = null;
          draft.bodyReplaced = true;
        }
        return body(200, { id: draft.id, subject: draft.subject });
      }
      if (method === 'POST' && action === 'attachments') {
        draft.attachments.push(payload as Draft['attachments'][number]);
        return body(201, { id: `draft-att-${draft.attachments.length}` });
      }
      if (method === 'DELETE' && action === undefined) {
        this.drafts.delete(draft.id);
        return body(204);
      }
      if (method === 'POST' && action === 'send') {
        const refused = this.refused();
        if (refused) return refused;
        const isForward = draft.kind === 'forward';
        this.outgoing.push({
          to: fromRecipients(draft.toRecipients),
          cc: fromRecipients(draft.ccRecipients),
          bcc: [],
          subject: draft.subject,
          body:
            draft.comment !== null
              ? { format: 'text', content: draft.comment }
              : {
                  format: draft.body.contentType === 'html' ? 'html' : 'text',
                  content: draft.body.content ?? '',
                },
          bodyPartCount: 1,
          threadId: isForward ? null : draft.original.threadId,
          inReplyTo: isForward ? null : draft.original.messageIdHeader,
          attachments: draft.attachments.map((a) => ({
            filename: a.name ?? '',
            mimeType: a.contentType ?? '',
            content: Buffer.from(a.contentBytes ?? '', 'base64'),
          })),
          // Graph forwards the stored original server side: its body and
          // attachments are carried by the provider, not by this request.
          // A forward whose body the client replaced no longer holds the
          // original's body: it is a retyped message, not the original.
          forwardedOriginal:
            isForward && !draft.bodyReplaced
              ? { messageId: draft.original.id, content: null }
              : null,
        });
        this.drafts.delete(draft.id);
        return body(202);
      }
    }
    return body(501, { error: { code: 'fake', message: `no route ${method} ${path}` } });
  }
}

const outlookDriver: MailContractDriver = {
  provider: 'outlook-mail',
  owner: MAIL_CONTRACT_OWNER,
  storedBytes: () => null,
  async run(op: MailContractOperation, mailbox, options) {
    const fake = new FakeGraph(mailbox, options);
    const client = Client.initWithMiddleware({ middleware: fake });
    let result: unknown;
    if (op.kind === 'send') {
      const tool = createSendEmailTool(client);
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
      const tool = createReplyMessageTool(client);
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
      const tool = createForwardMessageTool(client);
      result = await tool.execute(
        tool.inputSchema.parse({
          message_id: op.messageId,
          to: op.to,
          note: op.note,
        }),
        {} as never,
      );
    }
    return { result, outgoing: fake.outgoing };
  },
};

describe('Outlook @cap:connecter-un-service/moteur', () => {
  runMailContractSuite(outlookDriver);
});
