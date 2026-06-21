// _smoke.live.test.ts — LIVE end-to-end install of a real community skill from
// GitHub into a pglite DB + temp store. Network-dependent: gated behind the
// LIVE_SKILL_INSTALL env var so the normal suite stays offline. Run with:
//   LIVE_SKILL_INSTALL=1 pnpm --filter @nodal-agents/runner exec vitest run src/skills/_smoke.live.test.ts

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { eq, agentSkills } from '@nodal-agents/db';
import { installCommunitySkill } from './install';

let store: string;
afterAll(async () => {
  if (store) await rm(store, { recursive: true, force: true });
});

describe.skipIf(!process.env['LIVE_SKILL_INSTALL'])(
  'LIVE install: zarazhangrui/frontend-slides',
  () => {
    it('installs from GitHub, writes the row, detects scripts, lands files', async () => {
      const { db } = await spinUpTestDb();
      const seed = await seedMinimal(db);
      store = await mkdtemp(join(tmpdir(), 'nodal-smoke-store-'));

      const result = await installCommunitySkill({
        db: db as never,
        source: 'zarazhangrui/frontend-slides',
        skillStoreDir: store,
        entityId: seed.entityId,
      });

      // Result shape
      expect(result.slug).toBe('frontend-slides');
      expect(result.name).toBe('frontend-slides');
      expect(result.fileCount).toBeGreaterThan(20);
      const scriptPaths = result.installedScripts.map((s) => s.path);
      expect(scriptPaths).toContain('scripts/extract-pptx.py');
      expect(scriptPaths).toContain('scripts/deploy.sh');
      expect(scriptPaths).toContain('scripts/export-pdf.sh');
      // The plugins/ mirror (a nested skill) must be excluded — no duplicates.
      expect(scriptPaths.filter((p) => p.startsWith('plugins/'))).toEqual([]);
      expect(scriptPaths).toHaveLength(3);

      // DB row
      const [row] = await db
        .select()
        .from(agentSkills)
        .where(eq(agentSkills.slug, 'frontend-slides'))
        .limit(1);
      expect(row).toBeTruthy();
      expect(row!.isCommunity).toBe(true);
      expect(row!.source).toBe('zarazhangrui/frontend-slides');
      expect(row!.requiredBuiltins).toEqual(['skill_file_read', 'skill_file_list']);
      expect(row!.content).toContain("skill_file_read('frontend-slides'");
      expect(row!.content).toContain('run_skill_script');
      expect(row!.content).toContain('extract-pptx.py');

      // Files actually landed in the store
      await expect(stat(join(store, 'frontend-slides', 'SKILL.md'))).resolves.toBeTruthy();
      await expect(
        stat(
          join(
            store,
            'frontend-slides',
            'bold-template-pack',
            'templates',
            'blue-professional',
            'design.md',
          ),
        ),
      ).resolves.toBeTruthy();
    }, 120000);
  },
);

describe.skipIf(!process.env['LIVE_SKILL_INSTALL'])(
  'LIVE install: clawhub image-studio (zip)',
  () => {
    it('installs a ClawHub zip skill end-to-end', async () => {
      const { db } = await spinUpTestDb();
      const seed = await seedMinimal(db);
      const cstore = await mkdtemp(join(tmpdir(), 'nodal-smoke-claw-'));
      try {
        const src = 'https://clawhub.ai/danielblinker83-bot/image-studio';
        const result = await installCommunitySkill({
          db: db as never,
          source: src,
          skillStoreDir: cstore,
          entityId: seed.entityId,
        });
        expect(result.slug).toBeTruthy();
        expect(result.fileCount).toBeGreaterThan(0);

        const [row] = await db
          .select()
          .from(agentSkills)
          .where(eq(agentSkills.slug, result.slug))
          .limit(1);
        expect(row?.isCommunity).toBe(true);
        expect(row?.source).toBe(src);

        await expect(stat(join(cstore, result.slug, 'SKILL.md'))).resolves.toBeTruthy();
      } finally {
        await rm(cstore, { recursive: true, force: true });
      }
    }, 120000);
  },
);
