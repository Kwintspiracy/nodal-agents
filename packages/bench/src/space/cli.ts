// space/cli.ts — `pnpm bench:space`
//
//   pnpm bench:space sync                       le plan : ce qu'une synchronisation écrirait
//   pnpm bench:space sync --apply               l'écrit
//   pnpm bench:space sync --max-run-cost-usd 2  le plafond de coût par run de l'espace
//   pnpm bench:space sync --source <entityId>   l'équipe copiée, quand il y a plusieurs espaces
//   pnpm bench:space reset                      combien de souvenirs l'espace porte
//   pnpm bench:space reset --apply              les efface
//
// Sans `--apply`, rien n'est écrit : on lit le plan d'abord, toujours.

import { openStackDb } from '../workflows/stack';
import { resetSpaceMemory } from './reset';
import { applySync, planSync, renderPlan } from './sync';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function costCap(): number | undefined {
  const raw = arg('max-run-cost-usd');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--max-run-cost-usd expects a number (got ${raw})`);
  return n;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'sync' && command !== 'reset') {
    throw new Error('usage: pnpm bench:space sync|reset [--apply]');
  }
  const apply = flag('apply');
  const { db, close } = await openStackDb();
  try {
    if (command === 'sync') {
      const { workspacesRoot } = await import('@nodal-agents/tools');
      const source = arg('source');
      const cap = costCap();
      const { plan, desired } = await planSync(db, {
        workspacesRoot: workspacesRoot(),
        ...(source ? { sourceEntityId: source } : {}),
        ...(cap !== undefined ? { maxRunCostUsd: cap } : {}),
      });
      console.log(renderPlan(plan));
      if (!apply) {
        console.log('\nDry run: nothing written. Run again with --apply to write it.');
        return;
      }
      await applySync(db, plan, desired);
      console.log('\nApplied.');
      return;
    }
    const r = await resetSpaceMemory(db, { apply });
    console.log(
      r.deleted
        ? `Bench space ${r.spaceId}: ${r.memories} memory row(s) deleted.`
        : `Bench space ${r.spaceId}: ${r.memories} memory row(s)` +
            (apply ? '.' : '. Dry run: run again with --apply to delete them.'),
    );
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
