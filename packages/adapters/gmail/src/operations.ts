// Gmail adapter operation descriptors.
// Each slug MUST match the tool name produced by createGmailTools() exactly.
// Risk classification:
//   read        — gmail_list_*, gmail_get_*
//   write       — gmail_send_*, gmail_reply_*, gmail_forward_*, gmail_modify_*,
//                 gmail_trash_*, gmail_untrash_*, gmail_create_*, gmail_update_*,
//                 gmail_send_draft
//   destructive — gmail_delete_*
//
// Note: gmail_send_email, gmail_send_draft are classified as `destructive`
// because sending email is irreversible (outbound = permanent side-effect).
// gmail_trash_* and gmail_modify_* are `write` (reversible).

import type { OperationDescriptor } from '@nodal-agents/shared';

export const GMAIL_OPERATIONS: OperationDescriptor[] = [
  // ─── Read (9) ────────────────────────────────────────────────────────────────
  {
    slug: 'gmail_list_messages',
    name: 'List messages',
    risk: 'read',
    requiresApproval: false,
    description: 'Search and list emails by query.',
  },
  {
    slug: 'gmail_get_message',
    name: 'Get message',
    risk: 'read',
    requiresApproval: false,
    description: 'Retrieve a single email by ID.',
  },
  {
    slug: 'gmail_list_threads',
    name: 'List threads',
    risk: 'read',
    requiresApproval: false,
    description: 'List email conversation threads.',
  },
  {
    slug: 'gmail_get_thread',
    name: 'Get thread',
    risk: 'read',
    requiresApproval: false,
    description: 'Retrieve all messages in a thread.',
  },
  {
    slug: 'gmail_list_labels',
    name: 'List labels',
    risk: 'read',
    requiresApproval: false,
    description: 'List all Gmail labels.',
  },
  {
    slug: 'gmail_get_label',
    name: 'Get label',
    risk: 'read',
    requiresApproval: false,
    description: 'Retrieve a single label by ID.',
  },
  {
    slug: 'gmail_list_drafts',
    name: 'List drafts',
    risk: 'read',
    requiresApproval: false,
    description: 'List email drafts.',
  },
  {
    slug: 'gmail_get_attachment',
    name: 'Get attachment',
    risk: 'read',
    requiresApproval: false,
    description: 'Download an email attachment by ID.',
  },
  {
    slug: 'gmail_list_history',
    name: 'List history',
    risk: 'read',
    requiresApproval: false,
    description: 'List mailbox history changes since a given historyId.',
  },

  // ─── Write (11) ──────────────────────────────────────────────────────────────
  {
    slug: 'gmail_reply_message',
    name: 'Reply to message',
    risk: 'write',
    requiresApproval: false,
    description: 'Send a reply in an existing thread.',
  },
  {
    slug: 'gmail_forward_message',
    name: 'Forward message',
    risk: 'write',
    requiresApproval: false,
    description: 'Forward an email to new recipients.',
  },
  {
    slug: 'gmail_modify_labels',
    name: 'Modify labels',
    risk: 'write',
    requiresApproval: false,
    description: 'Add or remove labels on a message.',
  },
  {
    slug: 'gmail_trash_message',
    name: 'Trash message',
    risk: 'write',
    requiresApproval: false,
    description: 'Move a message to Trash (reversible).',
  },
  {
    slug: 'gmail_untrash_message',
    name: 'Untrash message',
    risk: 'write',
    requiresApproval: false,
    description: 'Restore a message from Trash.',
  },
  {
    slug: 'gmail_modify_thread_labels',
    name: 'Modify thread labels',
    risk: 'write',
    requiresApproval: false,
    description: 'Add or remove labels on all messages in a thread.',
  },
  {
    slug: 'gmail_trash_thread',
    name: 'Trash thread',
    risk: 'write',
    requiresApproval: false,
    description: 'Move an entire thread to Trash (reversible).',
  },
  {
    slug: 'gmail_create_label',
    name: 'Create label',
    risk: 'write',
    requiresApproval: false,
    description: 'Create a new Gmail label.',
  },
  {
    slug: 'gmail_update_label',
    name: 'Update label',
    risk: 'write',
    requiresApproval: false,
    description: 'Rename or update a Gmail label.',
  },
  {
    slug: 'gmail_create_draft',
    name: 'Create draft',
    risk: 'write',
    requiresApproval: false,
    description: 'Compose an email draft without sending.',
  },
  {
    slug: 'gmail_update_draft',
    name: 'Update draft',
    risk: 'write',
    requiresApproval: false,
    description: 'Update an existing email draft.',
  },

  // ─── Destructive (5) ─────────────────────────────────────────────────────────
  {
    slug: 'gmail_send_email',
    name: 'Send email',
    risk: 'destructive',
    requiresApproval: true,
    description: 'Send an email from the connected mailbox (irreversible).',
  },
  {
    slug: 'gmail_send_draft',
    name: 'Send draft',
    risk: 'destructive',
    requiresApproval: true,
    description: 'Send a saved draft (irreversible).',
  },
  {
    slug: 'gmail_delete_message',
    name: 'Delete message',
    risk: 'destructive',
    requiresApproval: true,
    description: 'Permanently delete a message (bypasses Trash).',
  },
  {
    slug: 'gmail_delete_label',
    name: 'Delete label',
    risk: 'destructive',
    requiresApproval: true,
    description: 'Permanently delete a Gmail label.',
  },
  {
    slug: 'gmail_delete_draft',
    name: 'Delete draft',
    risk: 'destructive',
    requiresApproval: true,
    description: 'Permanently delete an email draft.',
  },
];
