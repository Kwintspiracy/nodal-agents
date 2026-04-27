// @nodalai/adapter-gmail — public API
// Single factory: createGmailTools(opts) → ToolDefinition[]

import type { ToolDefinition } from '@nodalai/tools';
import type { z } from 'zod';
import { createGmailClient } from './client.js';

// Messages (8)
import { createSendEmailTool } from './tools/messages.js';
import { createListMessagesTool } from './tools/messages.js';
import { createGetMessageTool } from './tools/messages.js';
import { createReplyMessageTool } from './tools/messages.js';
import { createForwardMessageTool } from './tools/messages.js';
import { createModifyLabelsTool } from './tools/messages.js';
import { createTrashMessageTool } from './tools/messages.js';
import { createUntrashMessageTool } from './tools/messages.js';
import { createDeleteMessageTool } from './tools/messages.js';

// Threads (4)
import { createListThreadsTool } from './tools/threads.js';
import { createGetThreadTool } from './tools/threads.js';
import { createModifyThreadLabelsTool } from './tools/threads.js';
import { createTrashThreadTool } from './tools/threads.js';

// Labels (5)
import { createListLabelsTool } from './tools/labels.js';
import { createGetLabelTool } from './tools/labels.js';
import { createCreateLabelTool } from './tools/labels.js';
import { createUpdateLabelTool } from './tools/labels.js';
import { createDeleteLabelTool } from './tools/labels.js';

// Drafts (5)
import { createListDraftsTool } from './tools/drafts.js';
import { createCreateDraftTool } from './tools/drafts.js';
import { createUpdateDraftTool } from './tools/drafts.js';
import { createSendDraftTool } from './tools/drafts.js';
import { createDeleteDraftTool } from './tools/drafts.js';

// Attachments (1)
import { createGetAttachmentTool } from './tools/attachments.js';

// History (1)
import { createListHistoryTool } from './tools/history.js';

export interface GmailAdapterOptions {
  /**
   * User's current OAuth2 access token for Gmail.
   * Token refresh is the runner's responsibility — if the token expires,
   * tools throw GmailAdapterError({ code: 'gmail_unauthorized' }).
   */
  accessToken: string;
}

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
  const gmail = createGmailClient(opts.accessToken);

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
export { GmailAdapterError } from './errors.js';
export type { GmailErrorCode } from './errors.js';
