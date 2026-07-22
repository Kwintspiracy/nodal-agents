// Outlook Mail adapter operation descriptors.
// Each slug MUST match the tool name produced by createOutlookMailTools() exactly.
// Risk classification (calqué sur adapter-gmail — see adapter-gmail/src/operations.ts):
//   read        — outlook_list_*, outlook_get_*
//   write       — outlook_reply_*, outlook_forward_*, outlook_update_message,
//                 outlook_move_message, outlook_create_draft, outlook_update_draft,
//                 and outlook_delete_message (reversible — moves to Deleted Items,
//                 unlike outlook_delete_draft below)
//   destructive — outlook_send_email, outlook_send_draft (irreversible outbound
//                 side-effect, same rationale as gmail_send_email/gmail_send_draft),
//                 outlook_delete_draft (permanent, unlike outlook_delete_message)

import type { OperationDescriptor } from '@nodal-agents/shared';

export const OUTLOOK_MAIL_OPERATIONS: OperationDescriptor[] = [
  // ─── Read (5) ────────────────────────────────────────────────────────────────
  {
    slug: 'outlook_list_messages',
    name: 'List messages',
    risk: 'read',
    requiresApproval: false,
    description: 'Search and list Outlook emails, optionally scoped to a folder.',
  },
  {
    slug: 'outlook_get_message',
    name: 'Get message',
    risk: 'read',
    requiresApproval: false,
    description: 'Retrieve a single Outlook email by ID.',
  },
  {
    slug: 'outlook_list_drafts',
    name: 'List drafts',
    risk: 'read',
    requiresApproval: false,
    description: 'List Outlook email drafts.',
  },
  {
    slug: 'outlook_list_folders',
    name: 'List folders',
    risk: 'read',
    requiresApproval: false,
    description: 'List all Outlook mail folders.',
  },
  {
    slug: 'outlook_get_attachment',
    name: 'Get attachment',
    risk: 'read',
    requiresApproval: false,
    description: 'Download an email attachment by ID.',
  },

  // ─── Write (7) ───────────────────────────────────────────────────────────────
  {
    slug: 'outlook_reply_message',
    name: 'Reply to message',
    risk: 'write',
    requiresApproval: false,
    description: 'Send a reply (or reply-all) to an Outlook message.',
  },
  {
    slug: 'outlook_forward_message',
    name: 'Forward message',
    risk: 'write',
    requiresApproval: false,
    description: 'Forward an Outlook message to new recipients.',
  },
  {
    slug: 'outlook_delete_message',
    name: 'Delete message',
    risk: 'write',
    requiresApproval: false,
    description: 'Move a message to the Deleted Items folder (reversible).',
  },
  {
    slug: 'outlook_update_message',
    name: 'Update message',
    risk: 'write',
    requiresApproval: false,
    description: "Update a message's read status and/or categories.",
  },
  {
    slug: 'outlook_move_message',
    name: 'Move message',
    risk: 'write',
    requiresApproval: false,
    description: 'Move a message to a different mail folder.',
  },
  {
    slug: 'outlook_create_draft',
    name: 'Create draft',
    risk: 'write',
    requiresApproval: false,
    description: 'Compose an Outlook email draft without sending.',
  },
  {
    slug: 'outlook_update_draft',
    name: 'Update draft',
    risk: 'write',
    requiresApproval: false,
    description: 'Update an existing Outlook email draft.',
  },

  // ─── Destructive (3) ─────────────────────────────────────────────────────────
  {
    slug: 'outlook_send_email',
    name: 'Send email',
    risk: 'destructive',
    requiresApproval: true,
    description: 'Send an email from the connected Outlook mailbox (irreversible).',
  },
  {
    slug: 'outlook_send_draft',
    name: 'Send draft',
    risk: 'destructive',
    requiresApproval: true,
    description: 'Send a saved draft (irreversible).',
  },
  {
    slug: 'outlook_delete_draft',
    name: 'Delete draft',
    risk: 'destructive',
    requiresApproval: true,
    description: 'Permanently delete an Outlook email draft.',
  },
];
