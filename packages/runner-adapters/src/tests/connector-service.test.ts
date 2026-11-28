// connector-service.test.ts — which connectors are accounts of one service, and
// why the job's other sources never meet a connector's names.
//
// In a job, several connectors of one service lend each of their tool names
// once, with an `account` argument (`lendConnectorTools`, @nodal-agents/tools).
// "One service" is a declaration of the catalog (`CatalogEntry.service`, read
// by `connectorService`), because the attach paths that refuse two accounts
// under one name live in layers that cannot read this registry. This file
// holds the declaration to what the adapters really lend: two catalog slugs
// are one service exactly when their tools share a name.
//
// And the namespaces that keep the other sources apart from connector tools by
// construction: a connector tool name never carries `__` (every MCP tool is
// `<server>__<tool>`), never is a built-in's or a delivery tool's name, and
// never starts like a delegation tool. The job's assembly (`oneTargetPerName`)
// still refuses, loud, any name two sources lend; these hold that a correct
// install never reaches that refusal through the code it ships.

import { describe, it, expect } from 'vitest';
import { CONNECTOR_CATALOG, connectorService } from '@nodal-agents/shared';
import {
  createListConversationsTool,
  createSendAudioTool,
  createSendFileTool,
  createSendImageTool,
  createSendVideoTool,
  createSendVoiceTool,
  createTelegramSendMessageTool,
  createToolRegistry,
  registerBuiltins,
} from '@nodal-agents/tools';
import { ADAPTER_REGISTRY } from '../registry';

const namesOf = (slug: string): Set<string> =>
  new Set(ADAPTER_REGISTRY[slug]!.operations.map((o) => o.slug));

describe('one service, as the catalog declares it @cap:connecter-un-service/moteur', () => {
  const slugs = Object.keys(ADAPTER_REGISTRY).sort();

  it('every adapter has a catalog entry (the service is read there)', () => {
    const catalog = new Set(CONNECTOR_CATALOG.map((c) => c.slug));
    expect(slugs.filter((s) => !catalog.has(s))).toEqual([]);
  });

  for (let i = 0; i < slugs.length; i++) {
    for (let j = i + 1; j < slugs.length; j++) {
      const a = slugs[i]!;
      const b = slugs[j]!;
      it(`${a} / ${b}: one service exactly when their tools share a name`, () => {
        const shared = [...namesOf(a)].filter((n) => namesOf(b).has(n));
        expect(connectorService(a) === connectorService(b)).toBe(shared.length > 0);
      });
    }
  }

  it('two slugs of one service lend the same names (an account of either answers every call)', () => {
    for (const a of slugs) {
      for (const b of slugs) {
        if (a === b || connectorService(a) !== connectorService(b)) continue;
        expect([...namesOf(a)].sort(), `${a} / ${b}`).toEqual([...namesOf(b)].sort());
      }
    }
  });
});

describe('connector tool names never meet another source by construction @cap:connecter-un-service/moteur', () => {
  const connectorNames = Object.keys(ADAPTER_REGISTRY).flatMap((s) => [...namesOf(s)]);

  it('the names an adapter declares are the names its factory builds', () => {
    for (const [slug, entry] of Object.entries(ADAPTER_REGISTRY)) {
      expect(
        entry
          .toolFactory('placeholder')
          .map((t) => t.name)
          .sort(),
        slug,
      ).toEqual([...namesOf(slug)].sort());
    }
  });

  it('no connector tool name carries the MCP separator `__`', () => {
    expect(connectorNames.filter((n) => n.includes('__'))).toEqual([]);
  });

  it('no connector tool name is a built-in, a delivery tool or a delegation tool', () => {
    const registry = createToolRegistry();
    registerBuiltins(registry);
    const others = new Set([
      ...registry.list().map((t) => t.name),
      ...[
        createTelegramSendMessageTool(),
        createSendImageTool(),
        createSendFileTool(),
        createSendVideoTool(),
        createSendAudioTool(),
        createSendVoiceTool(),
        createListConversationsTool(),
      ].map((t) => t.name),
      'create_task',
      'list_tasks',
    ]);
    expect(connectorNames.filter((n) => others.has(n) || n.startsWith('assign_'))).toEqual([]);
  });

  it('no connector tool already takes an `account` argument (the accounts argument would shadow it)', () => {
    for (const [slug, entry] of Object.entries(ADAPTER_REGISTRY)) {
      for (const tool of entry.toolFactory('placeholder')) {
        const shape = (tool.inputSchema as { shape?: Record<string, unknown> }).shape;
        expect(shape, `${slug}/${tool.name} has an object input`).toBeDefined();
        expect(Object.keys(shape!), `${slug}/${tool.name}`).not.toContain('account');
      }
    }
  });
});
