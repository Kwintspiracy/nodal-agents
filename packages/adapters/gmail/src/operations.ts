// Gmail adapter operation descriptors.
// Each slug MUST match the tool name produced by createGmailTools() exactly.
// Risk classification:
//   read        — gmail_list_*, gmail_get_*
//   write       — gmail_modify_*, gmail_trash_*, gmail_untrash_*,
//                 gmail_create_*, gmail_update_*
//   destructive — gmail_send_*, gmail_reply_*, gmail_forward_*, gmail_delete_*
//
// Note: every operation that sends an email (send, send_draft, reply, forward)
// is `destructive` and requires approval: an email sent cannot be taken back
// (outbound = permanent side-effect; owner's decision on #711).
// gmail_trash_* and gmail_modify_* are `write` (reversible).

import type { OperationDescriptor, ScopeRequirement } from '@nodal-agents/shared';

// OAuth rights, from the Gmail API reference ("Authorization scopes" of each
// users.* method the tools call). First = the narrowest scope Nodal asks for;
// the others are the broader scopes Google also accepts for the same calls.
const GMAIL = 'https://www.googleapis.com/auth/gmail';
const READONLY = `${GMAIL}.readonly`;
const SEND = `${GMAIL}.send`;
const COMPOSE = `${GMAIL}.compose`;
const LABELS = `${GMAIL}.labels`;
const MODIFY = `${GMAIL}.modify`;
const FULL_MAILBOX = 'https://mail.google.com/';
/** messages / threads / history list and get, attachments.get */
const READ: ScopeRequirement = [READONLY, MODIFY, FULL_MAILBOX];
/** labels.list / labels.get (the labels scope reads them too) */
const READ_LABELS: ScopeRequirement = [READONLY, LABELS, MODIFY, FULL_MAILBOX];
/** drafts.list / drafts.get */
const READ_DRAFTS: ScopeRequirement = [READONLY, COMPOSE, MODIFY, FULL_MAILBOX];
/** messages.send */
const SEND_MAIL: ScopeRequirement = [SEND, COMPOSE, MODIFY, FULL_MAILBOX];
/** drafts.create / update / send / delete */
const DRAFTS: ScopeRequirement = [COMPOSE, MODIFY, FULL_MAILBOX];
/** labels.create / patch / delete */
const WRITE_LABELS: ScopeRequirement = [LABELS, MODIFY, FULL_MAILBOX];
/** messages / threads modify, trash, untrash */
const ORGANISE: ScopeRequirement = [MODIFY, FULL_MAILBOX];
/** messages.delete (permanent): the full mailbox scope only */
const PERMANENT_DELETE: ScopeRequirement = [FULL_MAILBOX];

export const GMAIL_OPERATIONS: OperationDescriptor[] = [
  // ─── Read (9) ────────────────────────────────────────────────────────────────
  {
    slug: 'gmail_list_messages',
    name: 'List messages',
    risk: 'read',
    requiresApproval: false,
    scopes: [READ],
    description: 'Search and list emails by query.',
  },
  {
    slug: 'gmail_get_message',
    name: 'Get message',
    risk: 'read',
    requiresApproval: false,
    scopes: [READ],
    description: 'Retrieve a single email by ID.',
  },
  {
    slug: 'gmail_list_threads',
    name: 'List threads',
    risk: 'read',
    requiresApproval: false,
    scopes: [READ],
    description: 'List email conversation threads.',
  },
  {
    slug: 'gmail_get_thread',
    name: 'Get thread',
    risk: 'read',
    requiresApproval: false,
    scopes: [READ],
    description: 'Retrieve all messages in a thread.',
  },
  {
    slug: 'gmail_list_labels',
    name: 'List labels',
    risk: 'read',
    requiresApproval: false,
    scopes: [READ_LABELS],
    description: 'List all Gmail labels.',
  },
  {
    slug: 'gmail_get_label',
    name: 'Get label',
    risk: 'read',
    requiresApproval: false,
    scopes: [READ_LABELS],
    description: 'Retrieve a single label by ID.',
  },
  {
    slug: 'gmail_list_drafts',
    name: 'List drafts',
    risk: 'read',
    requiresApproval: false,
    scopes: [READ_DRAFTS],
    description: 'List email drafts.',
  },
  {
    slug: 'gmail_get_attachment',
    name: 'Get attachment',
    risk: 'read',
    requiresApproval: false,
    scopes: [READ],
    description: 'Download an email attachment by ID.',
  },
  {
    slug: 'gmail_list_history',
    name: 'List history',
    risk: 'read',
    requiresApproval: false,
    scopes: [READ],
    description: 'List mailbox history changes since a given historyId.',
  },

  // ─── Write (9) ───────────────────────────────────────────────────────────────
  {
    slug: 'gmail_modify_labels',
    name: 'Modify labels',
    risk: 'write',
    requiresApproval: false,
    scopes: [ORGANISE],
    description: 'Add or remove labels on a message.',
  },
  {
    slug: 'gmail_trash_message',
    name: 'Trash message',
    risk: 'write',
    requiresApproval: false,
    scopes: [ORGANISE],
    description: 'Move a message to Trash (reversible).',
  },
  {
    slug: 'gmail_untrash_message',
    name: 'Untrash message',
    risk: 'write',
    requiresApproval: false,
    scopes: [ORGANISE],
    description: 'Restore a message from Trash.',
  },
  {
    slug: 'gmail_modify_thread_labels',
    name: 'Modify thread labels',
    risk: 'write',
    requiresApproval: false,
    scopes: [ORGANISE],
    description: 'Add or remove labels on all messages in a thread.',
  },
  {
    slug: 'gmail_trash_thread',
    name: 'Trash thread',
    risk: 'write',
    requiresApproval: false,
    scopes: [ORGANISE],
    description: 'Move an entire thread to Trash (reversible).',
  },
  {
    slug: 'gmail_create_label',
    name: 'Create label',
    risk: 'write',
    requiresApproval: false,
    scopes: [WRITE_LABELS],
    description: 'Create a new Gmail label.',
  },
  {
    slug: 'gmail_update_label',
    name: 'Update label',
    risk: 'write',
    requiresApproval: false,
    scopes: [WRITE_LABELS],
    description: 'Rename or update a Gmail label.',
  },
  {
    slug: 'gmail_create_draft',
    name: 'Create draft',
    risk: 'write',
    requiresApproval: false,
    scopes: [DRAFTS, READ],
    description: 'Compose an email draft without sending.',
  },
  {
    slug: 'gmail_update_draft',
    name: 'Update draft',
    risk: 'write',
    requiresApproval: false,
    scopes: [DRAFTS],
    description: 'Update an existing email draft.',
  },

  // ─── Destructive (7) ─────────────────────────────────────────────────────────
  {
    slug: 'gmail_reply_message',
    name: 'Reply to message',
    risk: 'destructive',
    requiresApproval: true,
    scopes: [READ, SEND_MAIL],
    description: 'Send a reply in an existing thread.',
  },
  {
    slug: 'gmail_forward_message',
    name: 'Forward message',
    risk: 'destructive',
    requiresApproval: true,
    scopes: [READ, SEND_MAIL],
    description: 'Forward an email to new recipients.',
  },
  {
    slug: 'gmail_send_email',
    name: 'Send email',
    risk: 'destructive',
    requiresApproval: true,
    scopes: [SEND_MAIL],
    description: 'Send an email from the connected mailbox (irreversible).',
  },
  {
    slug: 'gmail_send_draft',
    name: 'Send draft',
    risk: 'destructive',
    requiresApproval: true,
    scopes: [DRAFTS],
    description: 'Send a saved draft (irreversible).',
  },
  {
    slug: 'gmail_delete_message',
    name: 'Delete message',
    risk: 'destructive',
    requiresApproval: true,
    scopes: [PERMANENT_DELETE],
    description: 'Permanently delete a message (bypasses Trash).',
  },
  {
    slug: 'gmail_delete_label',
    name: 'Delete label',
    risk: 'destructive',
    requiresApproval: true,
    scopes: [WRITE_LABELS],
    description: 'Permanently delete a Gmail label.',
  },
  {
    slug: 'gmail_delete_draft',
    name: 'Delete draft',
    risk: 'destructive',
    requiresApproval: true,
    scopes: [DRAFTS],
    description: 'Permanently delete an email draft.',
  },
];
