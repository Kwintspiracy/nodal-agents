// @nodal-agents/adapter-gmail — public API
// Single factory: createGmailTools(opts) → ToolDefinition[]

import type { ToolDefinition } from '@nodal-agents/tools';
import type { z } from 'zod';
import { createGmailClient } from './client';

// Messages (8)
import { createSendEmailTool } from './tools/messages';
import { createListMessagesTool } from './tools/messages';
import { createGetMessageTool } from './tools/messages';
import { createReplyMessageTool } from './tools/messages';
import { createForwardMessageTool } from './tools/messages';
import { createModifyLabelsTool } from './tools/messages';
import { createTrashMessageTool } from './tools/messages';
import { createUntrashMessageTool } from './tools/messages';
import { createDeleteMessageTool } from './tools/messages';

// Threads (4)
import { createListThreadsTool } from './tools/threads';
import { createGetThreadTool } from './tools/threads';
import { createModifyThreadLabelsTool } from './tools/threads';
import { createTrashThreadTool } from './tools/threads';

// Labels (5)
import { createListLabelsTool } from './tools/labels';
import { createGetLabelTool } from './tools/labels';
import { createCreateLabelTool } from './tools/labels';
import { createUpdateLabelTool } from './tools/labels';
import { createDeleteLabelTool } from './tools/labels';

// Drafts (5)
import { createListDraftsTool } from './tools/drafts';
import { createCreateDraftTool } from './tools/drafts';
import { createUpdateDraftTool } from './tools/drafts';
import { createSendDraftTool } from './tools/drafts';
import { createDeleteDraftTool } from './tools/drafts';

// Attachments (1)
import { createGetAttachmentTool } from './tools/attachments';

// History (1)
import { createListHistoryTool } from './tools/history';

export type GmailAdapterOptions =
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
       * Resolver called before every Gmail API request — re-reads (and, via
       * the runner's advisory-lock refresh path, refreshes) the credential
       * from the DB instead of capturing one token for the tools' lifetime.
       */
      getAccessToken: () => Promise<string>;
    };

/**
 * Create all 25 Gmail tools using the provided OAuth access token.
 * Returns a flat ToolDefinition[] ready to register in a ToolRegistry.
 *
 * Tool count: 25
 * Read (9):        gmail_list_messages, gmail_get_message, gmail_list_threads,
 *                  gmail_get_thread, gmail_list_labels, gmail_get_label,
 *                  gmail_list_drafts, gmail_get_attachment, gmail_list_history
 * Write (13):      gmail_send_email, gmail_reply_message, gmail_forward_message,
 *                  gmail_modify_labels, gmail_trash_message, gmail_untrash_message,
 *                  gmail_modify_thread_labels, gmail_trash_thread,
 *                  gmail_create_label, gmail_update_label,
 *                  gmail_create_draft, gmail_update_draft, gmail_send_draft
 * Destructive (3): gmail_delete_message, gmail_delete_label, gmail_delete_draft
 */
export function createGmailTools(
  opts: GmailAdapterOptions,
): ToolDefinition<z.ZodTypeAny, unknown>[] {
  const getAccessToken =
    'getAccessToken' in opts ? opts.getAccessToken : async () => opts.accessToken;
  const gmail = createGmailClient(getAccessToken);

  return [
    // Read tools (9)
    createListMessagesTool(gmail),
    createGetMessageTool(gmail),
    createListThreadsTool(gmail),
    createGetThreadTool(gmail),
    createListLabelsTool(gmail),
    createGetLabelTool(gmail),
    createListDraftsTool(gmail),
    createGetAttachmentTool(gmail),
    createListHistoryTool(gmail),

    // Write tools (13)
    createSendEmailTool(gmail),
    createReplyMessageTool(gmail),
    createForwardMessageTool(gmail),
    createModifyLabelsTool(gmail),
    createTrashMessageTool(gmail),
    createUntrashMessageTool(gmail),
    createModifyThreadLabelsTool(gmail),
    createTrashThreadTool(gmail),
    createCreateLabelTool(gmail),
    createUpdateLabelTool(gmail),
    createCreateDraftTool(gmail),
    createUpdateDraftTool(gmail),
    createSendDraftTool(gmail),

    // Destructive tools (3)
    createDeleteMessageTool(gmail),
    createDeleteLabelTool(gmail),
    createDeleteDraftTool(gmail),
  ] as unknown as ToolDefinition<z.ZodTypeAny, unknown>[];
}

// Re-export error types for consumers
export { GmailAdapterError } from './errors';
export type { GmailErrorCode } from './errors';

// Re-export operation descriptors for UI and registry consumers
export { GMAIL_OPERATIONS } from './operations';
