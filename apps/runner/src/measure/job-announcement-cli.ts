// measure/job-announcement-cli.ts — rejoue l'annonce dite de jobs finis sur une base (#967).
//
//   pnpm --filter @nodal-agents/runner exec tsx src/measure/job-announcement-cli.ts \
//     --database-url <postgres://…> --jobs <id>,<id>,… --out <relevé.json> [--runs 5]
//
// (`--job <id>` reste accepté pour un seul job.) Aucune stack n'a besoin de
// tourner : la base suffit, et la clé du modèle est celle de l'agent de chaque
// job, déchiffrée dans ce processus comme le runner le fait
// (`resolveAgentLlmClient`), avec la clé maîtresse du foyer Nodal
// (NODALAI_HOME, sinon ~/.nodalai). Ni la clé du modèle ni la clé maîtresse ne
// sont jamais affichées, et tout texte d'erreur passe par `redactSecretsInText`.
// Ce que le rejeu écrit dans la base : rien (voir job-announcement.ts) ; ce
// qu'il écrit ailleurs : le fichier `--out`.

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { agents, createClient, entityLlmKeys, eq, type AnyDrizzleDb } from '@nodal-agents/db';
import { masterKeyFileMissing, masterKeyPath } from '@nodal-agents/secrets';
import { redactSecretsInText } from '@nodal-agents/shared';
import {
  measureJobAnnouncements,
  summarizeAnnouncements,
  summarizeSameness,
} from './job-announcement.ts';

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  console.error(`job-announcement: ${redactSecretsInText(message)}`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    'database-url': { type: 'string' },
    job: { type: 'string' },
    jobs: { type: 'string' },
    runs: { type: 'string', default: '5' },
    out: { type: 'string' },
  },
});

const databaseUrl = values['database-url'] ?? process.env['DATABASE_URL'];
if (!databaseUrl) fail('--database-url (or DATABASE_URL) is required');
const jobIds = (values.jobs ?? values.job ?? '')
  .split(',')
  .map((j) => j.trim())
  .filter((j) => j !== '');
if (jobIds.length === 0) fail('--jobs <id>,<id>,… (or --job <id>) is required');
if (!values.out) fail('--out <file.json> is required');
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) {
  fail(`--runs must be a positive integer, got "${values.runs}"`);
}
// Une clé maîtresse absente serait CRÉÉE au premier déchiffrement : refusé.
if (masterKeyFileMissing()) {
  fail(`no master key at ${masterKeyPath()}: point NODALAI_HOME at the stack's Nodal home`);
}

const client = createClient(databaseUrl, { max: 2 });
const db = client.db as unknown as AnyDrizzleDb;
try {
  const startedAt = new Date().toISOString();
  const measure = await measureJobAnnouncements(db, {
    jobIds,
    runs,
    onRecord: (r) =>
      say(
        r.text === null
          ? `${r.jobId.slice(0, 8)} run ${r.run} FAILED ${r.code}${r.detail ? `: ${r.detail}` : ''}`
          : `${r.jobId.slice(0, 8)} run ${r.run} ${r.ms} ms, ${r.words} words, ${r.sentences} sentences` +
              `${r.sharedPhrase ? ` | READS: "${r.sharedPhrase}"` : ''}` +
              `${r.numbersFromResult.length ? ` | numbers ${r.numbersFromResult.join(',')}` : ''}` +
              `${r.channelNames.length ? ` | CHANNELS ${r.channelNames.join(',')}` : ''}` +
              `${r.whereToRead.length ? ` | WHERE "${r.whereToRead.join('", "')}"` : ''}` +
              `${r.markdown ? ' | MARKDOWN' : ''}${r.url ? ' | URL' : ''}\n  ${r.text}`,
      ),
  });
  const agentRows = await Promise.all(
    [...new Set(measure.jobs.map((j) => j.agentId))].map(async (id) => {
      const [a] = await db
        .select({
          id: agents.id,
          slug: agents.slug,
          model: agents.model,
          provider: entityLlmKeys.provider,
        })
        .from(agents)
        .leftJoin(entityLlmKeys, eq(entityLlmKeys.id, agents.llmKeyId))
        .where(eq(agents.id, id));
      return a ?? null;
    }),
  );
  const perJob = measure.jobs.map((j) => ({
    ...j,
    summary: summarizeAnnouncements(measure.records.filter((r) => r.jobId === j.id)),
  }));
  writeFileSync(
    values.out,
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        jobs: perJob,
        agents: agentRows,
        runs,
        sameness: measure.sameness,
        records: measure.records,
      },
      null,
      2,
    ),
  );
  for (const j of perJob) {
    const a = agentRows.find((r) => r?.id === j.agentId);
    say(
      `\njob ${j.id}, result ${j.resultChars} chars; agent ${a?.slug ?? '?'} ` +
        `(${a?.provider ?? '?'} ${a?.model ?? '?'})\n${j.summary}`,
    );
  }
  say(`\n${summarizeSameness(measure.sameness)}\n\nwritten: ${values.out}`);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await client.close();
}
