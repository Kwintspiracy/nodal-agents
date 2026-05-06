// @nodalai/adapter-gmail — label tools
// list, get, create, update, delete

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { gmail_v1 } from 'googleapis';
import { mapGmailError } from '../errors';

// ── gmail_list_labels ─────────────────────────────────────────────────────────

const ListLabelsInput = z.object({});

export type ListLabelsOutput = {
  total: number;
  labels: Array<{
    id: string;
    name: string;
    type: string;
    messageListVisibility: string;
    labelListVisibility: string;
    messagesTotal: number;
    messagesUnread: number;
    threadsTotal: number;
    threadsUnread: number;
  }>;
};

export function createListLabelsTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof ListLabelsInput, ListLabelsOutput> {
  return {
    name: 'gmail_list_labels',
    description:
      'List all Gmail labels — both system labels (INBOX, SENT, TRASH, SPAM, etc.) and user-created labels. ' +
      'Returns label IDs needed for gmail_modify_labels.',
    inputSchema: ListLabelsInput,
    riskLevel: 'read',
    async execute() {
      try {
        const res = await gmail.users.labels.list({ userId: 'me' });
        const labels = (res.data.labels ?? []).map((l) => ({
          id: l.id ?? '',
          name: l.name ?? '',
          type: l.type ?? '',
          messageListVisibility: l.messageListVisibility ?? '',
          labelListVisibility: l.labelListVisibility ?? '',
          messagesTotal: l.messagesTotal ?? 0,
          messagesUnread: l.messagesUnread ?? 0,
          threadsTotal: l.threadsTotal ?? 0,
          threadsUnread: l.threadsUnread ?? 0,
        }));
        return { total: labels.length, labels };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_get_label ───────────────────────────────────────────────────────────

const GetLabelInput = z.object({
  label_id: z
    .string()
    .describe("Label ID (from gmail_list_labels). System labels: 'INBOX', 'SENT', etc."),
});

export type GetLabelOutput = {
  id: string;
  name: string;
  type: string;
  messagesTotal: number;
  messagesUnread: number;
  threadsTotal: number;
  threadsUnread: number;
};

export function createGetLabelTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof GetLabelInput, GetLabelOutput> {
  return {
    name: 'gmail_get_label',
    description: 'Get details and message counts for a specific Gmail label.',
    inputSchema: GetLabelInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const res = await gmail.users.labels.get({
          userId: 'me',
          id: input.label_id,
        });
        const l = res.data;
        return {
          id: l.id ?? '',
          name: l.name ?? '',
          type: l.type ?? '',
          messagesTotal: l.messagesTotal ?? 0,
          messagesUnread: l.messagesUnread ?? 0,
          threadsTotal: l.threadsTotal ?? 0,
          threadsUnread: l.threadsUnread ?? 0,
        };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_create_label ────────────────────────────────────────────────────────

const CreateLabelInput = z.object({
  name: z.string().describe("Label name. Use '/' for nesting, e.g. 'Clients/Acme'."),
  label_list_visibility: z
    .enum(['labelShow', 'labelShowIfUnread', 'labelHide'])
    .optional()
    .describe('Sidebar visibility (default labelShow).'),
  message_list_visibility: z
    .enum(['show', 'hide'])
    .optional()
    .describe('Visibility in message list (default show).'),
});

export type CreateLabelOutput = {
  id: string;
  name: string;
};

export function createCreateLabelTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof CreateLabelInput, CreateLabelOutput> {
  return {
    name: 'gmail_create_label',
    description:
      "Create a new Gmail user label. Use '/' in the name to nest labels, e.g. 'Projects/NodalAI'.",
    inputSchema: CreateLabelInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const res = await gmail.users.labels.create({
          userId: 'me',
          requestBody: {
            name: input.name,
            labelListVisibility: input.label_list_visibility ?? 'labelShow',
            messageListVisibility: input.message_list_visibility ?? 'show',
          },
        });
        return {
          id: res.data.id ?? '',
          name: res.data.name ?? '',
        };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_update_label ────────────────────────────────────────────────────────

const UpdateLabelInput = z.object({
  label_id: z.string().describe('Label ID to update (from gmail_list_labels).'),
  name: z.string().optional().describe('New label name.'),
  label_list_visibility: z
    .enum(['labelShow', 'labelShowIfUnread', 'labelHide'])
    .optional()
    .describe('Sidebar visibility.'),
  message_list_visibility: z.enum(['show', 'hide']).optional().describe('Message list visibility.'),
});

export type UpdateLabelOutput = {
  id: string;
  name: string;
};

export function createUpdateLabelTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof UpdateLabelInput, UpdateLabelOutput> {
  return {
    name: 'gmail_update_label',
    description: 'Update an existing Gmail user label — rename it or change its visibility.',
    inputSchema: UpdateLabelInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const requestBody: gmail_v1.Schema$Label = {};
        if (input.name !== undefined) requestBody.name = input.name;
        if (input.label_list_visibility !== undefined)
          requestBody.labelListVisibility = input.label_list_visibility;
        if (input.message_list_visibility !== undefined)
          requestBody.messageListVisibility = input.message_list_visibility;

        const res = await gmail.users.labels.patch({
          userId: 'me',
          id: input.label_id,
          requestBody,
        });
        return {
          id: res.data.id ?? '',
          name: res.data.name ?? '',
        };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_delete_label ────────────────────────────────────────────────────────

const DeleteLabelInput = z.object({
  label_id: z
    .string()
    .describe('Label ID to permanently delete (cannot delete system labels like INBOX).'),
});

export type DeleteLabelOutput = {
  deleted: boolean;
  labelId: string;
};

export function createDeleteLabelTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof DeleteLabelInput, DeleteLabelOutput> {
  return {
    name: 'gmail_delete_label',
    description:
      'Permanently delete a Gmail user label. Cannot delete system labels (INBOX, SENT, etc.). ' +
      'Messages with this label are NOT deleted — they simply lose the label.',
    inputSchema: DeleteLabelInput,
    riskLevel: 'destructive',
    async execute(input) {
      try {
        await gmail.users.labels.delete({
          userId: 'me',
          id: input.label_id,
        });
        return { deleted: true, labelId: input.label_id };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}
