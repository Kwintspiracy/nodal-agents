// Outlook Mail adapter operation descriptors.
// Each slug MUST match the tool name produced by createOutlookMailTools() exactly.
// Risk classification (calqué sur adapter-gmail — see adapter-gmail/src/operations.ts):
//   read        — outlook_list_*, outlook_get_*
//   write       — outlook_update_message, outlook_move_message,
//                 outlook_create_draft, outlook_update_draft, and
//                 outlook_delete_message (reversible — moves to Deleted Items,
//                 unlike outlook_delete_draft below)
//   destructive — outlook_send_email, outlook_send_draft, outlook_reply_*,
//                 outlook_forward_* (every operation that sends an email:
//                 irreversible outbound side-effect, owner's decision on #711),
//                 outlook_delete_draft (permanent, unlike outlook_delete_message)

import type { OperationDescriptor, ScopeRequirement } from '@nodal-agents/shared';

// OAuth rights, from the Microsoft Graph permissions of each call (delegated,
// graph/api/*?view=graph-rest-1.0). First = the permission Nodal asks for; the
// others are the ones Graph also accepts for the same call. Reading asks for
// Mail.ReadWrite, which the changing operations need anyway, and accepts
// Mail.Read. How Microsoft writes a granted permission (prefix, case) is the
// provider entry's `grantedScopeForm`, not this list's concern.
const GRAPH = 'https://graph.microsoft.com/';
/** list / get messages, list drafts, list mail folders, get attachment */
const READ_MAIL: ScopeRequirement = [`${GRAPH}Mail.ReadWrite`, `${GRAPH}Mail.Read`];
/** create / update / delete drafts, update / move / delete messages */
const WRITE_MAIL: ScopeRequirement = [`${GRAPH}Mail.ReadWrite`];
/** sendMail, send a draft, reply, forward */
const SEND_MAIL: ScopeRequirement = [`${GRAPH}Mail.Send`];

export const OUTLOOK_MAIL_OPERATIONS: OperationDescriptor[] = [
  // ─── Read (5) ────────────────────────────────────────────────────────────────
  {
    slug: 'outlook_list_messages',
    name: 'List messages',
    risk: 'read',
    requiresApproval: false,
    // One page per call, in the connector contract's list shape.
    returns: 'list',
    scopes: [READ_MAIL],
    description: 'Search and list Outlook emails, optionally scoped to a folder.',
  },
  {
    slug: 'outlook_get_message',
    name: 'Get message',
    risk: 'read',
    requiresApproval: false,
    scopes: [READ_MAIL],
    description: 'Retrieve a single Outlook email by ID.',
  },
  {
    slug: 'outlook_list_drafts',
    name: 'List drafts',
    risk: 'read',
    requiresApproval: false,
    scopes: [READ_MAIL],
    description: 'List Outlook email drafts.',
  },
  {
    slug: 'outlook_list_folders',
    name: 'List folders',
    risk: 'read',
    requiresApproval: false,
    scopes: [READ_MAIL],
    description: 'List all Outlook mail folders.',
  },
  {
    slug: 'outlook_get_attachment',
    name: 'Get attachment',
    risk: 'read',
    requiresApproval: false,
    scopes: [READ_MAIL],
    description: 'Download an email attachment by ID.',
  },

  // ─── Write (5) ───────────────────────────────────────────────────────────────
  {
    slug: 'outlook_delete_message',
    name: 'Delete message',
    risk: 'write',
    requiresApproval: false,
    scopes: [WRITE_MAIL],
    description: 'Move a message to the Deleted Items folder (reversible).',
  },
  {
    slug: 'outlook_update_message',
    name: 'Update message',
    risk: 'write',
    requiresApproval: false,
    scopes: [WRITE_MAIL],
    description: "Update a message's read status and/or categories.",
  },
  {
    slug: 'outlook_move_message',
    name: 'Move message',
    risk: 'write',
    requiresApproval: false,
    scopes: [WRITE_MAIL],
    description: 'Move a message to a different mail folder.',
  },
  {
    slug: 'outlook_create_draft',
    name: 'Create draft',
    risk: 'write',
    requiresApproval: false,
    scopes: [WRITE_MAIL],
    description: 'Compose an Outlook email draft without sending.',
  },
  {
    slug: 'outlook_update_draft',
    name: 'Update draft',
    risk: 'write',
    requiresApproval: false,
    scopes: [WRITE_MAIL],
    description: 'Update an existing Outlook email draft.',
  },

  // ─── Destructive (5) ─────────────────────────────────────────────────────────
  {
    slug: 'outlook_reply_message',
    name: 'Reply to message',
    risk: 'destructive',
    requiresApproval: true,
    scopes: [SEND_MAIL],
    description: 'Send a reply (or reply-all) to an Outlook message.',
  },
  {
    slug: 'outlook_forward_message',
    name: 'Forward message',
    risk: 'destructive',
    requiresApproval: true,
    scopes: [SEND_MAIL],
    description: 'Forward an Outlook message to new recipients.',
  },
  {
    slug: 'outlook_send_email',
    name: 'Send email',
    risk: 'destructive',
    requiresApproval: true,
    scopes: [SEND_MAIL],
    description: 'Send an email from the connected Outlook mailbox (irreversible).',
  },
  {
    slug: 'outlook_send_draft',
    name: 'Send draft',
    risk: 'destructive',
    requiresApproval: true,
    scopes: [SEND_MAIL],
    description: 'Send a saved draft (irreversible).',
  },
  {
    slug: 'outlook_delete_draft',
    name: 'Delete draft',
    risk: 'destructive',
    requiresApproval: true,
    scopes: [WRITE_MAIL],
    description: 'Permanently delete an Outlook email draft.',
  },
];
