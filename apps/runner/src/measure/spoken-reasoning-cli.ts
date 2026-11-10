// measure/spoken-reasoning-cli.ts — lance la mesure de #977 sur une base.
//
//   pnpm --filter @nodal-agents/runner exec tsx src/measure/spoken-reasoning-cli.ts \
//     --database-url <postgres://…> --agent <slug ou id> --out <relevé.json> \
//     [--entity <id>] [--efforts off,low,auto] [--runs 3] [--requests <demandes.json>] \
//     [--persona-file <fiche.md>]
//
// Aucune stack n'a besoin de tourner : la base suffit, et la clé du modèle est
// celle de l'agent, déchiffrée dans ce processus comme le runner le fait
// (`resolveAgentLlmClient`), avec la clé maîtresse du foyer Nodal
// (NODALAI_HOME, sinon ~/.nodalai). Ni la clé du modèle ni la clé maîtresse ne
// sont jamais affichées. Ce que la mesure écrit dans la base : rien (voir
// spoken-reasoning.ts) ; ce qu'elle écrit ailleurs : le fichier `--out`.
//
// `--persona-file` (#995) joue la fiche (`personality`) de l'agent mesuré avec
// le texte du fichier, sur la copie annulée de chaque tour : `public.agents` ne
// change pas. Chaque relevé et l'en-tête disent quelle fiche a été jouée.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { agents, and, createClient, entityLlmKeys, eq, type AnyDrizzleDb } from '@nodal-agents/db';
import { findModelCatalogEntry } from '@nodal-agents/shared';
import { masterKeyFileMissing, masterKeyPath } from '@nodal-agents/secrets';
import {
  describePersona,
  describeStoredPersona,
  loadPersonaFile,
  personaInfo,
  type PersonaInfo,
  type PersonaVariant,
} from './persona.ts';
import {
  measureSpokenReasoning,
  parseMeasuredEffort,
  readDelegableTeammates,
  rescoreRecords,
  summarize,
  summaryTable,
  SPOKEN_REASONING_REQUESTS,
  type MeasureRequest,
  type TurnRecord,
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
    rescore: { type: 'string' },
    teammates: { type: 'string' },
    'persona-file': { type: 'string' },
  },
});

// --rescore <in.json>: re-applies the CURRENT detectors to a stored run, from
// the full replies it holds. No model call, no database, no key: it reads a file
// and prints the table (and writes --out when given). Teammate names are the ones
// the run stored, or --teammates a,b.
if (values.rescore) {
  const stored = JSON.parse(readFileSync(values.rescore, 'utf-8')) as {
    records?: TurnRecord[];
    teammateNames?: string[];
    persona?: PersonaInfo;
  };
  if (!Array.isArray(stored.records)) fail(`${values.rescore}: no "records" array`);
  const names = values.teammates
    ? values.teammates.split(',').map((n) => n.trim())
    : (stored.teammateNames ?? []);
  let records;
  try {
    records = rescoreRecords(stored.records, names);
  } catch (err) {
    fail((err as Error).message);
  }
  const summary = summarize(records);
  say(`rescored ${records.length} turns with ${names.length} teammate names`);
  say(describeStoredPersona(stored.persona, records));
  say(summaryTable(summary));
  if (values.out) {
    writeFileSync(
      values.out,
      JSON.stringify({ ...stored, teammateNames: names, summary, records }, null, 2),
    );
    say(`written: ${values.out}`);
  }
  process.exit(0);
}

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
// The sheet variant is read BEFORE anything else is touched: a missing, empty
// or non-UTF-8 file stops the measure here, not after the first paid turn (#4).
let persona: PersonaVariant | undefined;
if (values['persona-file'] !== undefined) {
  try {
    persona = loadPersonaFile(values['persona-file']);
  } catch (err) {
    fail((err as Error).message);
  }
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
      personality: agents.personality,
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

  // Which sheet this run plays: the file's, or the stored one with its sha256.
  const runPersona: PersonaInfo = personaInfo(persona ? persona.text : agent.personality, persona);
  say(describePersona(runPersona));

  // The teammates this agent can hand a task to (active, on its own team, never
  // itself), read from the database: a launch line that names one narrates the
  // routing (#995). Never a list written here.
  const teammateNames = await readDelegableTeammates(db, agent.id);
  say(`${teammateNames.length} teammate names read from the workspace`);

  const startedAt = new Date().toISOString();
  const records = await measureSpokenReasoning(db, {
    entityId: agent.entityId,
    agentId: agent.id,
    efforts,
    runs,
    requests,
    teammateNames,
    ...(persona ? { persona } : {}),
    onTurn: (r) =>
      say(
        `run ${r.run} ${r.effort.padEnd(6)} ${r.requestId.padEnd(14)} ` +
          `${r.calledRunTask ? 'run_task' : 'reply   '} ${r.rightDecision ? 'right' : 'WRONG'} ` +
          `first ${r.firstDeltaMs ?? '-'} ms, ${r.replyOutputTokens ?? '-'} tok, ` +
          `${r.replyWords} words, ${r.replySentences} sentences` +
          `${r.routingNarration ? ' NARRATES ROUTING' : ''}${r.launchNarration ? ' NARRATES LAUNCH' : ''}${r.error ? ` error ${r.error}` : ''} | ${r.opening}`,
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
        persona: runPersona,
        efforts,
        runs,
        requests,
        teammateNames,
        summary,
        records,
      },
      null,
      2,
    ),
  );
  say(`\n${describePersona(runPersona)}\n\n${summaryTable(summary)}\n\nwritten: ${values.out}`);
} finally {
  await client.close();
}
