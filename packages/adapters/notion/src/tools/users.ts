// @nodal-agents/adapter-notion — user tools

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { Client } from '@notionhq/client';
import { mapNotionError } from '../errors';

// ── notion_list_users ─────────────────────────────────────────────────────────

const ListUsersInput = z.object({
  page_size: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(100)
    .describe('Max users to return (default 100).'),
});

export type UserEntry = {
  id: string;
  name: string;
  type: string;
  email: string;
  avatar_url: string;
};

export type ListUsersOutput = {
  total: number;
  users: UserEntry[];
};

export function createListUsersTool(
  client: Client,
): ToolDefinition<typeof ListUsersInput, ListUsersOutput> {
  return {
    name: 'notion_list_users',
    description: 'List all users in the Notion workspace.',
    inputSchema: ListUsersInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const res = await client.users.list({ page_size: input.page_size });
        const users: UserEntry[] = res.results.map((u) => {
          const person =
            u.type === 'person' && 'person' in u ? (u.person as { email?: string }) : null;
          return {
            id: u.id,
            name: u.name ?? '',
            type: u.type ?? 'unknown',
            email: person?.email ?? '',
            avatar_url: u.avatar_url ?? '',
          };
        });
        return { total: users.length, users };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}

// ── notion_get_user ───────────────────────────────────────────────────────────

const GetUserInput = z.object({
  user_id: z.string().describe('Notion user ID.'),
});

export type GetUserOutput = {
  id: string;
  name: string;
  type: string;
  email: string;
  avatar_url: string;
};

export function createGetUserTool(
  client: Client,
): ToolDefinition<typeof GetUserInput, GetUserOutput> {
  return {
    name: 'notion_get_user',
    description: 'Get details about a specific Notion user by their ID.',
    inputSchema: GetUserInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const u = await client.users.retrieve({ user_id: input.user_id });
        const person =
          u.type === 'person' && 'person' in u ? (u.person as { email?: string }) : null;
        return {
          id: u.id,
          name: u.name ?? '',
          type: u.type ?? 'unknown',
          email: person?.email ?? '',
          avatar_url: u.avatar_url ?? '',
        };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}
