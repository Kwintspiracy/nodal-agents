// @nodal-agents/adapter-outlook-mail — public API
// Single factory: createOutlookMailTools(opts) → ToolDefinition[]

import type { ToolDefinition } from '@nodal-agents/tools';
import type { z } from 'zod';
import { createOutlookClient } from './client';

// Messages (8)
import {
  createListMessagesTool,
  createGetMessageTool,
  createSendEmailTool,
  createReplyMessageTool,
  createForwardMessageTool,
  createDeleteMessageTool,
  createUpdateMessageTool,
  createMoveMessageTool,
} from './tools/messages';

// Drafts (5)
import {
  createListDraftsTool,
  createCreateDraftTool,
  createUpdateDraftTool,
  createSendDraftTool,
  createDeleteDraftTool,
} from './tools/drafts';

// Folders (1)
import { createListFoldersTool } from './tools/folders';

// Attachments (1)
import { createGetAttachmentTool } from './tools/attachments';

export type OutlookMailAdapterOptions =
  | {
      /**
       * Static OAuth2 access token, captured once for the tools' lifetime.
       * Fine for short-lived callers (tests, the UI operations grid). Jobs
       * that may outlive the ~1h Microsoft token TTL should pass
       * getAccessToken instead (same rationale as adapter-gmail's audit#2 M-12).
       */
      accessToken: string;
    }
  | {
      /**
       * Resolver called before every Graph request — re-reads (and, via the
       * runner's advisory-lock refresh path, refreshes) the credential from
       * the DB instead of capturing one token for the tools' lifetime.
       */
      getAccessToken: () => Promise<string>;
    };

/**
 * Create all 15 Outlook Mail tools using the provided Microsoft Graph access token.
 * Returns a flat ToolDefinition[] ready to register in a ToolRegistry.
 *
 * Tool count: 15
 * Read (5):        outlook_list_messages, outlook_get_message, outlook_list_drafts,
 *                  outlook_list_folders, outlook_get_attachment
 * Write (7):       outlook_reply_message, outlook_forward_message, outlook_delete_message,
 *                  outlook_update_message, outlook_move_message, outlook_create_draft,
 *                  outlook_update_draft
 * Destructive (3): outlook_send_email, outlook_send_draft, outlook_delete_draft
 */
export function createOutlookMailTools(
  opts: OutlookMailAdapterOptions,
): ToolDefinition<z.ZodTypeAny, unknown>[] {
  const getAccessToken =
    'getAccessToken' in opts ? opts.getAccessToken : async () => opts.accessToken;
  const client = createOutlookClient(getAccessToken);

  return [
    // Read tools (5)
    createListMessagesTool(client),
    createGetMessageTool(client),
    createListDraftsTool(client),
    createListFoldersTool(client),
    createGetAttachmentTool(client),

    // Write tools (7)
    createReplyMessageTool(client),
    createForwardMessageTool(client),
    createDeleteMessageTool(client),
    createUpdateMessageTool(client),
    createMoveMessageTool(client),
    createCreateDraftTool(client),
    createUpdateDraftTool(client),

    // Destructive tools (3)
    createSendEmailTool(client),
    createSendDraftTool(client),
    createDeleteDraftTool(client),
  ] as unknown as ToolDefinition<z.ZodTypeAny, unknown>[];
}

// Re-export error types for consumers
export { OutlookAdapterError } from './errors';
export type { OutlookErrorCode } from './errors';

// Re-export operation descriptors for UI and registry consumers
export { OUTLOOK_MAIL_OPERATIONS } from './operations';
