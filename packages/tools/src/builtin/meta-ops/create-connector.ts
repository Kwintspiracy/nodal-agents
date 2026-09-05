// meta-ops/create-connector.ts — create_connector meta-tool
// Lets the ROOT agent register an API-key connector in its entity.
//
// Catalog-gated (invariant: no half-baked catalog) — the slug MUST be a known
// connector with a working adapter, validated against the shared
// CONNECTOR_CATALOG (same list the dashboard UI uses). Only `api_key`
// connectors are creatable here; OAuth connectors need the interactive
// dashboard flow, so they are rejected fail-loud. The key is encrypted at rest
// via the injected provisioning capability (packages/tools imports neither the
// secrets package nor apps/web).
//
// Mirrors saveApiKeyConnectorAction (apps/web): api_key connectors have no
// live "test connection" step, so this is validate → encrypt → insert.
//
// riskLevel 'write': additive. Approval is gated by the ROOT's autonomy level.

import { z } from 'zod';
import { eq, and } from '@nodal-agents/db';
import { connectors } from '@nodal-agents/db';
import { CONNECTOR_CATALOG } from '@nodal-agents/shared';
import type { ToolDefinition } from '../../types';
import { resolveAgentId, linkConnectorToAgent } from './link-helpers';

const CreateConnectorInput = z.object({
  slug: z
    .string()
    .min(1)
    .describe(
      'Connector catalog slug — must be a known api_key connector (see the connector catalog).',
    ),
  name: z.string().min(1).describe('Display name for this connector instance.'),
  apiKey: z.string().min(1).describe('The provider API key / token (stored encrypted at rest).'),
  attachToAgentSlug: z
    .string()
    .optional()
    .describe(
      'Optional: slug/name of an agent to immediately attach this connector to, so its tools ' +
        'become usable by that agent. Without this, the connector is registered but NOT usable — ' +
        'attach it later with attach_connector.',
    ),
});

type CreateConnectorOutput = { ok: true; message: string } | { ok: false; error: string };

export const createConnectorTool: ToolDefinition<
  typeof CreateConnectorInput,
  CreateConnectorOutput
> = {
  name: 'create_connector',
  description:
    'Register an API-key connector in this entity from the known catalog. ' +
    'Provide the catalog slug + a name + the API key (stored encrypted). ONLY api_key ' +
    'connectors are supported here — OAuth connectors (Gmail, Google Drive, …) must be set up ' +
    'via the dashboard OAuth flow. Fails with a clear error for an unknown slug, a non-api_key ' +
    'slug, or if a connector with this exact slug AND name already exists in this entity — do ' +
    'NOT retry this tool if a previous call may already have succeeded; check existing ' +
    'connectors first. A different name with the same slug is fine (multi-instance, e.g. a ' +
    'second account for the same provider).',
  inputSchema: CreateConnectorInput,
  riskLevel: 'write',
  card: 'text',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    const provisioning = ctx.provisioning;
    if (!provisioning) {
      return { ok: false, error: 'Connector provisioning is not available in this context.' };
    }

    const catalog = CONNECTOR_CATALOG.find((c) => c.slug === input.slug);
    if (!catalog) {
      return {
        ok: false,
        error: `Unknown connector slug "${input.slug}". Choose one from the connector catalog.`,
      };
    }
    if (catalog.authType !== 'api_key') {
      return {
        ok: false,
        error: `Connector "${input.slug}" uses ${catalog.authType}, not api_key — set it up via the dashboard OAuth flow instead.`,
      };
    }

    // Idempotence guard (P0-S1, 2026-07-22 incident): a connector with this
    // exact (entity, slug, name) triple already existing means a prior call
    // already did the job — fail loud instead of inserting a duplicate row.
    // Keyed on (slug, name) rather than slug alone so legitimate multi-instance
    // connectors (e.g. two Gmail accounts, same slug, different names) are
    // NOT blocked — only an exact-duplicate stutter is.
    const [existing] = await ctx.db
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.entityId, ctx.entityId),
          eq(connectors.slug, input.slug),
          eq(connectors.name, input.name),
        ),
      );
    if (existing) {
      return {
        ok: false,
        error:
          `A connector named "${input.name}" for slug "${input.slug}" already exists in this ` +
          'entity. Use attach_connector to make it usable by an agent — to change its key, edit ' +
          'it in the dashboard. Do not call create_connector again with the same slug and name.',
      };
    }

    const [inserted] = await ctx.db
      .insert(connectors)
      .values({
        entityId: ctx.entityId,
        slug: input.slug,
        name: input.name,
        apiKey: provisioning.encrypt(input.apiKey),
        authType: 'api_key',
        active: true,
      })
      .returning({ id: connectors.id });

    let suffix =
      ' (not attached to any agent yet — use attach_connector to make its tools usable).';
    if (input.attachToAgentSlug && inserted) {
      const agentId = await resolveAgentId(ctx.db, ctx.entityId, input.attachToAgentSlug);
      if (!agentId) {
        suffix = ` (note: could not attach — no agent "${input.attachToAgentSlug}" found; attach it later with attach_connector).`;
      } else {
        await linkConnectorToAgent(ctx.db, ctx.entityId, agentId, inserted.id);
        suffix = ` Attached to agent "${input.attachToAgentSlug}" — its tools are now available to that agent.`;
      }
    }
    return {
      ok: true,
      message: `Registered connector "${input.name}" (${catalog.label}, slug ${input.slug}).${suffix}`,
    };
  },
};
