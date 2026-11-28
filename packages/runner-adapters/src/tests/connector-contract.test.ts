// connector-contract.test.ts — every operation of every adapter, held to the
// connector contract, as the registry assembles it for a job.
//
// The table is the registry itself: an adapter added to ADAPTER_REGISTRY is
// measured here without anyone writing a line, and a new one cannot be added
// to the ratchet (contract-ratchet.ts) to escape it.

import { writeFileSync } from 'node:fs';
import {
  runConnectorContractSuite,
  sampleFromSchema,
  type ContractAdapter,
  type ContractTool,
} from '@nodal-agents/test-kit/connector-contract-suite';
import { ADAPTER_REGISTRY } from '../registry';
import { CONTRACT_PROVIDERS } from './contract-providers';
import { CONTRACT_RATCHET, LIST_OPERATIONS, RATCHET_FROZEN_ADAPTERS } from './contract-ratchet';
import { CONTRACT_SAMPLE_INPUTS, contractSampleContext } from './contract-samples';
import { CONTRACT_LIST_FIXTURES } from './contract-lists';

const TOKEN = 'contract-suite-token';

function adapterOf(slug: string): ContractAdapter {
  const entry = ADAPTER_REGISTRY[slug]!;
  const provider = CONTRACT_PROVIDERS[slug];
  if (!provider) throw new Error(`no fake provider for the registry entry "${slug}"`);
  const build = (io: { fetch: typeof fetch; boundMs: number }) =>
    entry.toolFactory(TOKEN, io) as unknown as readonly ContractTool[];
  const schemas = new Map(build({ fetch, boundMs: 1 }).map((t) => [t.name, t.inputSchema]));
  return {
    slug,
    operations: entry.operations.map((op) => ({
      slug: op.slug,
      risk: op.risk,
      ...(op.returns === 'list' ? { returns: 'list' as const } : {}),
      ...(op.returns === 'list' || LIST_OPERATIONS.includes(op.slug)
        ? { isList: true as const }
        : {}),
      ...(op.effectOutsideTransport ? { effectOutsideTransport: true as const } : {}),
    })),
    build,
    provider,
    sampleInput: (op) => CONTRACT_SAMPLE_INPUTS[slug]?.[op] ?? sampleFromSchema(schemas.get(op)!),
    sampleContext: (op) => contractSampleContext(slug, op),
    listFixtures: CONTRACT_LIST_FIXTURES[slug] ?? {},
  };
}

const REPORT = process.env['NODAL_CONTRACT_REPORT'];

runConnectorContractSuite({
  adapters: Object.keys(ADAPTER_REGISTRY).map(adapterOf),
  ratchet: CONTRACT_RATCHET,
  frozenAdapters: RATCHET_FROZEN_ADAPTERS,
  ...(REPORT
    ? {
        report: (report, results) =>
          writeFileSync(REPORT, JSON.stringify({ report, results }, null, 2)),
      }
    : {}),
});
