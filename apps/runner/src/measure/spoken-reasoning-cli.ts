// measure/spoken-reasoning-cli.ts — lance la mesure de #977 sur une base.
//
//   pnpm --filter @nodal-agents/runner exec tsx src/measure/spoken-reasoning-cli.ts \
//     --database-url <postgres://…> --agent <slug ou id> --out <relevé.json> \
//     [--entity <id>] [--efforts off,low,auto] [--runs 3] [--requests <demandes.json>]
//
// Aucune stack n'a besoin de tourner : la base suffit, et la clé du modèle est
// celle de l'agent, déchiffrée dans ce processus comme le runner le fait
// (`resolveAgentLlmClient`), avec la clé maîtresse du foyer Nodal
// (NODALAI_HOME, sinon ~/.nodalai). Ni la clé du modèle ni la clé maîtresse ne
// sont jamais affichées. Ce que la mesure écrit dans la base : rien (voir
// spoken-reasoning.ts) ; ce qu'elle écrit ailleurs : le fichier `--out`.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { agents, and, createClient, entityLlmKeys, eq, type AnyDrizzleDb } from '@nodal-agents/db';
import { findModelCatalogEntry } from '@nodal-agents/shared';
import { masterKeyFileMissing, masterKeyPath } from '@nodal-agents/secrets';
import {
  measureSpokenReasoning,
  parseMeasuredEffort,
  summarize,
  summaryTable,
  SPOKEN_REASONING_REQUESTS,
  type MeasureRequest,
} from './spoken-reasoning.ts';

/** Le relevé de la mesure, sur la sortie standard : un outil de mesure, pas le runner. */
function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  console.error(`spoken-reasoning: ${message}`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    'database-url': { type: 'string' },
    agent: { type: 'string' },
    entity: { type: 'string' },
    efforts: { type: 'string', default: 'off,low,auto' },
    runs: { type: 'string', default: '3' },
    requests: { type: 'string' },
    out: { type: 'string' },
  },
});

const databaseUrl = values['database-url'] ?? process.env['DATABASE_URL'];
if (!databaseUrl) fail('--database-url (or DATABASE_URL) is required');
if (!values.agent) fail('--agent <slug or id> is required');
if (!values.out) fail('--out <file.json> is required');
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1)
  fail(`--runs must be a positive integer, got "${values.runs}"`);
let efforts;
try {
  efforts = values.efforts.split(',').map((e) => parseMeasuredEffort(e.trim()));
} catch (err) {
  fail((err as Error).message);
}
let requests: readonly MeasureRequest[] = SPOKEN_REASONING_REQUESTS;
if (values.requests) {
  const parsed = JSON.parse(readFileSync(values.requests, 'utf-8')) as unknown;
  const ok =
    Array.isArray(parsed) &&
    parsed.every(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as MeasureRequest).id === 'string' &&
        typeof (r as MeasureRequest).text === 'string' &&
        typeof (r as MeasureRequest).needsTask === 'boolean',
    );
  if (!ok) fail(`${values.requests}: expected [{ id, text, needsTask }]`);
  requests = parsed as MeasureRequest[];
}
// Une clé maîtresse absente serait CRÉÉE au premier déchiffrement
// (loadOrCreateMasterKey) : la mesure refuse plutôt que d'en poser une.
if (masterKeyFileMissing()) {
  fail(`no master key at ${masterKeyPath()}: point NODALAI_HOME at the stack's Nodal home`);
}

const client = createClient(databaseUrl, { max: 2 });
const db = client.db as unknown as AnyDrizzleDb;
try {
  const isId = /^[0-9a-f-]{36}$/i.test(values.agent);
  const found = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      entityId: agents.entityId,
      model: agents.model,
      llmKeyId: agents.llmKeyId,
      reasoningEffort: agents.reasoningEffort,
      // Pas `spokenReasoningEffort` : la base mesurée peut ne pas avoir encore
      // la migration 0159 (spoken-reasoning.ts, la copie de chaque tour).
    })
    .from(agents)
    .where(
      and(
        isId ? eq(agents.id, values.agent) : eq(agents.slug, values.agent),
        ...(values.entity ? [eq(agents.entityId, values.entity)] : []),
      ),
    );
  if (found.length === 0) fail(`no agent "${values.agent}"`);
  if (found.length > 1) {
    fail(
      `"${values.agent}" names ${found.length} agents; pass --entity, one of: ` +
        found.map((a) => a.entityId).join(', '),
    );
  }
  const agent = found[0]!;
  if (!agent.entityId) fail(`agent "${agent.slug}" has no workspace`);

  // Le contrôle que le catalogue déclare pour ce modèle : ce que chaque effort
  // mesuré devient dans la requête (un palier absent est normalisé ou ignoré
  // par le fournisseur — à lire avant de conclure).
  const [key] = agent.llmKeyId
    ? await db
        .select({ provider: entityLlmKeys.provider })
        .from(entityLlmKeys)
        .where(eq(entityLlmKeys.id, agent.llmKeyId))
    : [];
  if (!key) fail(`agent "${agent.slug}" has no LLM key`);
  const control =
    agent.model !== null
      ? (findModelCatalogEntry(key.provider, agent.model)?.capabilities.reasoningControl ?? null)
      : null;
  say(
    `agent ${agent.slug} (${agent.id}), ${key.provider} ${agent.model ?? 'n/a'}, ` +
      `catalog control ${JSON.stringify(control)}`,
  );
  say(
    `stored Reasoning ${agent.reasoningEffort ?? 'auto'} (unchanged: each turn sets the measured ` +
      `effort on its own rolled-back copy)`,
  );
  say(
    `${efforts.length} efforts × ${requests.length} requests × ${runs} runs = ` +
      `${efforts.length * requests.length * runs} turns`,
  );

  const startedAt = new Date().toISOString();
  const records = await measureSpokenReasoning(db, {
    entityId: agent.entityId,
    agentId: agent.id,
    efforts,
    runs,
    requests,
    onTurn: (r) =>
      say(
        `run ${r.run} ${r.effort.padEnd(6)} ${r.requestId.padEnd(14)} ` +
          `${r.calledRunTask ? 'run_task' : 'reply   '} ${r.rightDecision ? 'right' : 'WRONG'} ` +
          `first ${r.firstDeltaMs ?? '-'} ms, ${r.replyOutputTokens ?? '-'} tok, ` +
          `${r.replyWords} words, ${r.replySentences} sentences` +
          `${r.routingNarration ? ' NARRATES ROUTING' : ''}${r.error ? ` error ${r.error}` : ''} | ${r.opening}`,
      ),
  });
  const summary = summarize(records);
  writeFileSync(
    values.out,
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        agent: {
          id: agent.id,
          slug: agent.slug,
          provider: key.provider,
          model: agent.model,
          reasoningControl: control,
        },
        efforts,
        runs,
        requests,
        summary,
        records,
      },
      null,
      2,
    ),
  );
  say(`\n${summaryTable(summary)}\n\nwritten: ${values.out}`);
} finally {
  await client.close();
}
