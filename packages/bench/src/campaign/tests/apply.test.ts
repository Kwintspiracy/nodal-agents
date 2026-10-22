// apply.test.ts — la configuration du banc appliquée à une instance neuve donne EXACTEMENT l'équipe de la page.
//
// Chaque fait est relu dans la base de l'instance par les lecteurs du produit
// (les outils d'un job, le bloc d'équipe que le modèle reçoit, la règle
// d'accord que l'exécution applique, les liaisons de canal, les méta-outils de
// la racine), jamais par l'objet que l'applicateur a rendu. Et la
// configuration elle-même : ce que son schéma refuse, son empreinte.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as d from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { commandExecutionSkill, officeEditingSkill } from '@nodal-agents/catalog';
import { decrypt } from '@nodal-agents/secrets';
import { BENCH_PRINTER_RECORDS_ENV } from '../../printer/identity';
import { checkSpaceCannotSend } from '../../space/guard';
import { readBenchPrinter } from '../../workflows/stack';
import { applyCampaignConfig, type AppliedCampaign } from '../apply';
import {
  CAMPAIGN_CONFIG_FILE,
  CampaignConfigSchema,
  configFingerprint,
  loadCampaignConfig,
} from '../config';
import { campaignModelApplier } from '../model';
import { allowedReachOf } from '../run';
import { readWorkspaceView, teamDrift, winningApproval, type WorkspaceView } from '../team';
import { TEST_KEYS, fakeCommunityInstaller, freshInstanceDb, isolateUserHome } from './harness';

const home = isolateUserHome();
const config = loadCampaignConfig();
let db: AnyDrizzleDb;
let applied: AppliedCampaign;
let banc: WorkspaceView;
let juge: WorkspaceView;
let installs: Array<{ source: string; entityId: string }>;
const foldersRoot = mkdtempSync(join(tmpdir(), 'bench-campaign-folders-'));
// Le dossier que le BANC donne à son imprimante ; la campagne le prend dans le
// dossier de la campagne (instancePaths, prouvé par campaign.test.ts).
const printerRecordsDir = join(foldersRoot, 'bench-printer-records');

beforeAll(async () => {
  ({ db } = await freshInstanceDb());
  const installer = fakeCommunityInstaller(db);
  installs = installer.calls;
  // La vraie liste d'outils : le serveur du banc est lancé une fois, comme
  // l'écran des connecteurs le lance avant d'enregistrer un serveur stdio.
  applied = await applyCampaignConfig(db, config, TEST_KEYS, {
    foldersRoot,
    printerRecordsDir,
    installCommunitySkill: installer.install,
  });
  banc = await readWorkspaceView(db, applied.tested.entityId);
  juge = await readWorkspaceView(db, applied.judge.entityId);
});

afterAll(() => {
  rmSync(foldersRoot, { recursive: true, force: true });
  home.restore();
});

const agent = (ws: WorkspaceView, slug: string) => {
  const a = ws.agents.find((x) => x.slug === slug);
  if (!a) throw new Error(`no agent ${slug} in ${ws.name}`);
  return a;
};

describe('the applied instance is the team of the page', () => {
  it('two workspaces: Banc with Chef, Chercheur, Imageur; Juge alone in its own', async () => {
    expect(banc.name).toBe('Banc');
    expect(juge.name).toBe('Juge');
    expect(banc.entityId).not.toBe(juge.entityId);
    expect(banc.agents.map((a) => a.slug)).toEqual(['chef', 'chercheur', 'imageur']);
    expect(juge.agents.map((a) => a.slug)).toEqual(['juge']);
    // Et rien d'autre dans toute l'instance : l'espace local que `up` sème reste vide.
    const all = await db.select({ slug: d.agents.slug }).from(d.agents);
    expect(all.map((a) => a.slug).sort()).toEqual(['chef', 'chercheur', 'imageur', 'juge']);
  });

  it('Chef is the root, with every root right off: no meta-tool at all', () => {
    expect(banc.rootAgentId).toBe(applied.agents['chef']!.id);
    expect(banc.rootMetaTools).toEqual([]);
    for (const meta of [
      'create_agent',
      'update_agent',
      'create_skill',
      'attach_connector',
      'attach_mcp',
    ]) {
      expect(agent(banc, 'chef').tools).not.toContain(meta);
    }
    expect(banc.autoRunPaused).toBe(false);
    expect(banc.reflectionEnabled).toBe(false);
    expect(banc.mcpServerEnabled).toBe(true);
  });

  it('every tested agent runs the tested model on the OpenRouter key; the judge runs GLM 5.3', () => {
    for (const slug of ['chef', 'chercheur', 'imageur']) {
      const a = agent(banc, slug);
      expect(`${a.provider}:${a.model}`).toBe('openrouter:anthropic/claude-haiku-5.5');
      expect(a.runtime).toBe('nodal');
    }
    expect(`${agent(juge, 'juge').provider}:${agent(juge, 'juge').model}`).toBe(
      'openrouter:z-ai/glm-5.3',
    );
  });

  it('the keys are written encrypted, never in clear', async () => {
    const keys = await db.select({ apiKey: d.entityLlmKeys.apiKey }).from(d.entityLlmKeys);
    expect(keys).toHaveLength(2);
    for (const k of keys) {
      expect(k.apiKey.startsWith('enc:v1:')).toBe(true);
      expect(k.apiKey).not.toContain('sk-or-test');
    }
    const conns = await db.select({ apiKey: d.connectors.apiKey }).from(d.connectors);
    expect(conns.map((c) => c.apiKey?.startsWith('enc:v1:'))).toEqual([true, true]);
  });

  it('personalities and delegation texts are the page’s, as the team block hands them to Chef', () => {
    const chef = agent(banc, 'chef');
    expect(chef.personality).toBe(config.agents.find((a) => a.slug === 'chef')!.personality);
    expect(chef.team).toEqual([
      { slug: 'chercheur', instructions: 'Recherche approfondie, rapport avec sources' },
      { slug: 'imageur', instructions: "Génération d'images" },
    ]);
    expect(chef.teamBlock).toContain('Recherche approfondie, rapport avec sources');
    expect(chef.teamBlock).toContain("Génération d'images");
    expect(chef.delegationTools).toEqual(['assign_chercheur', 'assign_imageur']);
  });

  it('the judge is out of reach: no tested agent can delegate to it or names it', async () => {
    for (const a of banc.agents) {
      expect(a.tools.some((t) => t.includes('juge'))).toBe(false);
      expect(a.delegationTools).not.toContain('assign_juge');
      expect(a.teamBlock).not.toContain('Juge');
    }
    const cross = await db
      .select({ id: d.agentAssignments.id })
      .from(d.agentAssignments)
      .where(d.eq(d.agentAssignments.subAgentId, applied.agents['juge']!.id));
    expect(cross).toEqual([]);
  });

  it('Chef holds the office tools and run_command through its skills, run without asking', async () => {
    const chef = agent(banc, 'chef');
    expect(chef.skills).toEqual([
      'claude-html-design',
      'command-execution',
      'office-editing',
      'print-request',
    ]);
    const wanted = [
      ...officeEditingSkill.requiredBuiltins!,
      ...commandExecutionSkill.requiredBuiltins!,
    ];
    expect(wanted).toContain('xlsx_read');
    expect(wanted).toContain('pptx_create');
    expect(wanted).toContain('run_command');
    for (const t of wanted) {
      expect(chef.tools).toContain(t);
    }
    expect(
      await winningApproval(db, banc.entityId, applied.agents['chef']!.id, 'run_command'),
    ).toBe('auto_approve');
  });

  it('Chercheur reads the web through Tavily and Firecrawl, read operations only, and has its Obsidian vault', () => {
    const c = agent(banc, 'chercheur');
    expect(c.skills).toEqual(['citation-discipline', 'obsidian', 'research-scope-discipline']);
    expect(c.connectors).toEqual([
      {
        slug: 'firecrawl',
        operations: [
          'firecrawl_crawl_start',
          'firecrawl_crawl_status',
          'firecrawl_map',
          'firecrawl_scrape',
          'firecrawl_search',
        ],
      },
      { slug: 'tavily', operations: ['tavily_crawl', 'tavily_extract', 'tavily_search'] },
    ]);
    expect(c.outbound.map((o) => `${o.origin}:${o.via}:${o.tool}`)).toEqual([
      'connector:firecrawl:firecrawl_crawl_start',
      'connector:firecrawl:firecrawl_crawl_status',
      'connector:firecrawl:firecrawl_map',
      'connector:firecrawl:firecrawl_scrape',
      'connector:firecrawl:firecrawl_search',
      'connector:tavily:tavily_crawl',
      'connector:tavily:tavily_extract',
      'connector:tavily:tavily_search',
    ]);
    expect(c.folders.map((f) => f.label)).toEqual(['Coffre Obsidian du banc']);
    expect(c.folders[0]!.path.startsWith(foldersRoot)).toBe(true);
    // Chercheur ne délègue pas : aucun méta-outil, aucune délégation.
    expect(c.delegationTools).toEqual([]);
  });

  it('Imageur drives ComfyUI through the community skill and run_command, run without asking', async () => {
    const i = agent(banc, 'imageur');
    expect(i.skills).toEqual(['comfy', 'command-execution']);
    expect(i.tools).toContain('run_command');
    expect(installs).toEqual([
      { source: 'Comfy-Org/comfy-cli/comfy_cli/skills/comfy', entityId: banc.entityId },
    ]);
    expect(
      await winningApproval(db, banc.entityId, applied.agents['imageur']!.id, 'run_command'),
    ).toBe('auto_approve');
  });

  it('the judge is read-only: every write and command tool is blocked, its evidence folder attached', async () => {
    const j = agent(juge, 'juge');
    for (const tool of [
      'file_write',
      'file_edit',
      'skill_file_write',
      'run_command',
      'run_skill_script',
    ]) {
      expect(await winningApproval(db, juge.entityId, applied.agents['juge']!.id, tool)).toBe(
        'block',
      );
    }
    expect(j.folders.map((f) => f.label)).toEqual(["Preuves de l'essai"]);
    expect(j.tools).toContain('file_read');
  });

  it('nothing can leave the machine: zero channel binding, no token, no outbound connector beyond the declared reads', async () => {
    const bindings = await db.select({ id: d.channelBindings.id }).from(d.channelBindings);
    expect(bindings).toEqual([]);
    for (const a of [...banc.agents, ...juge.agents]) {
      expect(a.channelBindings).toBe(0);
      expect(a.hasTelegramToken).toBe(false);
    }
    // Outside the Chercheur's eight read operations and Chef's bench printer,
    // nobody reaches outside.
    expect(banc.agents.filter((a) => a.slug !== 'chercheur').flatMap((a) => a.outbound)).toEqual([
      { tool: 'bench_printer__get_print_request', origin: 'mcp', via: 'bench-printer' },
      { tool: 'bench_printer__request_print', origin: 'mcp', via: 'bench-printer' },
    ]);
    expect(juge.agents.flatMap((a) => a.outbound)).toEqual([]);
    // The pre-trial check passes with the configuration's declared reach…
    const declared = await checkSpaceCannotSend(db, banc.entityId, allowedReachOf(config));
    expect(declared.findings).toEqual([]);
    expect(declared.ok).toBe(true);
    // …and that reach is the ONLY thing it lets through: without it, the same
    // team is refused, connector by connector.
    const bare = await checkSpaceCannotSend(db, banc.entityId);
    expect(bare.ok).toBe(false);
    expect([...bare.findings].sort()).toEqual([
      'agent chef reaches outside Nodal through bench-printer (mcp): bench_printer__get_print_request, bench_printer__request_print',
      'agent chercheur reaches outside Nodal through firecrawl (connector): firecrawl_crawl_start, firecrawl_crawl_status, firecrawl_map, firecrawl_scrape, firecrawl_search',
      'agent chercheur reaches outside Nodal through tavily (connector): tavily_crawl, tavily_extract, tavily_search',
    ]);
  });

  // #794 : l'imprimante du banc, par le chemin de l'écran des connecteurs. Chaque
  // fait est relu par un lecteur du produit ou par celui du juge.
  it('Chef holds the bench printer: its declaration, the folder the bench gave, its tools, and both of them without asking', async () => {
    // The judge reads it from the team, as the runner would start it.
    expect(await readBenchPrinter(db, banc.entityId, printerRecordsDir)).toEqual({
      kind: 'attached',
      recordsDir: printerRecordsDir,
    });
    expect(applied.printerRecordsDir).toBe(printerRecordsDir);
    // The row as the product writes it: the environment encrypted value by
    // value, the tools the server really listed.
    const [row] = await db
      .select({
        envVars: d.mcpServers.envVars,
        availableTools: d.mcpServers.availableTools,
        entityId: d.mcpServers.entityId,
      })
      .from(d.mcpServers)
      .where(d.eq(d.mcpServers.slug, 'bench-printer'));
    expect(row!.entityId).toBe(banc.entityId);
    const stored = (row!.envVars as Record<string, string>)[BENCH_PRINTER_RECORDS_ENV]!;
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(decrypt(stored)).toBe(printerRecordsDir);
    expect((row!.availableTools as Array<{ name: string }>).map((t) => t.name).sort()).toEqual([
      'get_print_request',
      'request_print',
    ]);
    // Chef receives both tools, nobody else any; both pass without asking:
    // request_print (the owner's D3 = a), and get_print_request, a read of the
    // bench's own printer with no outward effect (D3 extended by the
    // orchestrator, 22/10: checking a request's status must not end a trial).
    expect(agent(banc, 'chef').tools.filter((t) => t.startsWith('bench_printer__'))).toEqual([
      'bench_printer__get_print_request',
      'bench_printer__request_print',
    ]);
    for (const other of ['chercheur', 'imageur'])
      expect(agent(banc, other).tools.some((t) => t.startsWith('bench_printer__'))).toBe(false);
    expect(juge.agents.flatMap((a) => a.tools).some((t) => t.startsWith('bench_printer__'))).toBe(
      false,
    );
    const chef = applied.agents['chef']!.id;
    expect(await winningApproval(db, banc.entityId, chef, 'bench_printer__request_print')).toBe(
      'auto_approve',
    );
    expect(await winningApproval(db, banc.entityId, chef, 'bench_printer__get_print_request')).toBe(
      'auto_approve',
    );
    // Nobody else holds a rule on them.
    for (const other of ['chercheur', 'imageur'])
      expect(
        await winningApproval(
          db,
          banc.entityId,
          applied.agents[other]!.id,
          'bench_printer__request_print',
        ),
      ).toBeNull();
  });

  it('the drift check reads the applied team as exactly the configuration', async () => {
    expect(await teamDrift(db, config, applied)).toEqual([]);
  });

  it('applying twice is refused: the applier creates on a fresh instance, it never merges', async () => {
    const installer = fakeCommunityInstaller(db);
    await expect(
      applyCampaignConfig(db, config, TEST_KEYS, {
        foldersRoot,
        printerRecordsDir,
        installCommunitySkill: installer.install,
      }),
    ).rejects.toThrow(/campaign_instance_not_fresh: the instance already has 4 agent\(s\)/);
  });
});

describe('the model applier of the matrix (#769), decided', () => {
  it('sets EVERY tested agent on the model, leaves the judge alone, and restores exactly', async () => {
    const applier = campaignModelApplier(db, config, applied);
    const applying = await applier.apply({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
    });
    const during = await readWorkspaceView(db, applied.tested.entityId);
    expect(during.agents.map((a) => `${a.slug}=${a.provider}:${a.model}`)).toEqual([
      'chef=openrouter:deepseek/deepseek-v4-flash',
      'chercheur=openrouter:deepseek/deepseek-v4-flash',
      'imageur=openrouter:deepseek/deepseek-v4-flash',
    ]);
    expect(agent(await readWorkspaceView(db, applied.judge.entityId), 'juge').model).toBe(
      'z-ai/glm-5.3',
    );
    expect(await teamDrift(db, config, applied)).toContain(
      'Banc:chef model is "openrouter:deepseek/deepseek-v4-flash", not "openrouter:anthropic/claude-haiku-5.5"',
    );
    await applying.restore();
    expect(await teamDrift(db, config, applied)).toEqual([]);
  });

  it('refuses a model of the judge’s family: the judge never grades its own family', async () => {
    const applier = campaignModelApplier(db, config, applied);
    await expect(
      applier.apply({ provider: 'openrouter', model: 'z-ai/glm-5.3-flash' }),
    ).rejects.toThrow(
      /campaign_model_judge_family: openrouter:z-ai\/glm-5\.3-flash is of the judge's family/,
    );
    expect(await teamDrift(db, config, applied)).toEqual([]);
  });

  it('refuses a provider the tested workspace holds no key for, before writing anything', async () => {
    const applier = campaignModelApplier(db, config, applied);
    await expect(
      applier.apply({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }),
    ).rejects.toThrow(/campaign_model_key: the tested workspace has 0 active anthropic key\(s\)/);
    expect(await teamDrift(db, config, applied)).toEqual([]);
  });
});

describe('the configuration as data', () => {
  const raw = (): Record<string, unknown> =>
    JSON.parse(readFileSync(CAMPAIGN_CONFIG_FILE, 'utf8')) as Record<string, unknown>;
  interface RawConfig {
    instance: { ports: { web: number } };
    models: { judge: unknown };
    agents: Array<{
      slug: string;
      personality: string;
      skills: string[];
      connectors: Array<{ slug: string; operations: string[] }>;
      delegatesTo: Array<{ agent: string; instructions: string }>;
    }>;
  }
  const refusal = (mutate: (c: RawConfig) => void): string => {
    const c = raw() as unknown as RawConfig;
    mutate(c);
    const r = CampaignConfigSchema.safeParse(c);
    return r.success ? '(accepted)' : r.error.issues.map((i) => i.message).join(' | ');
  };

  it('refuses a connector operation that is not a read', () => {
    expect(
      refusal((c) => {
        c.agents[0]!.connectors.push({ slug: 'gmail', operations: ['gmail_send_message'] });
      }),
    ).toMatch(/gmail is not an API-key connector of the registry/);
    expect(
      refusal((c) => {
        c.agents[0]!.connectors[0]!.operations.push('tavily_send');
      }),
    ).toMatch(/tavily has no operation tavily_send/);
    expect(
      refusal((c) => {
        c.agents[0]!.connectors.push({
          slug: 'airtable',
          operations: [
            'airtable_list_records',
            'airtable_create_records',
            'airtable_delete_record',
          ],
        });
      }),
    ).toBe(
      'airtable_create_records is a write operation: the bench instance only reads outside | ' +
        'airtable_delete_record is a destructive operation: the bench instance only reads outside',
    );
  });

  it('refuses the default ports of an installation, a judge of the tested family, a delegation across workspaces', () => {
    expect(refusal((c) => (c.instance.ports.web = 3000))).toMatch(
      /port 3000 is a default Nodal port/,
    );
    expect(
      refusal(
        (c) => (c.models.judge = { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' }),
      ),
    ).toMatch(/the judge is never of the tested model’s family/);
    expect(
      refusal((c) => {
        c.agents
          .find((a) => a.slug === 'chef')!
          .delegatesTo.push({ agent: 'juge', instructions: 'x' });
      }),
    ).toMatch(/chef delegates outside its workspace \(juge\)/);
    expect(refusal((c) => (c.agents[0]!.skills = ['not-a-skill']))).toMatch(
      /skill not-a-skill is not in the product catalog/,
    );
  });

  it('the fingerprint is the configuration’s, not the file’s: key order does not change it, a personality does', () => {
    const base = configFingerprint(config);
    const reordered = Object.fromEntries(Object.entries(raw()).reverse());
    const dir = mkdtempSync(join(tmpdir(), 'bench-campaign-config-'));
    try {
      const file = join(dir, 'banc.json');
      writeFileSync(file, JSON.stringify(reordered, null, 4));
      expect(configFingerprint(loadCampaignConfig(file))).toBe(base);
      const changed = raw() as unknown as RawConfig;
      changed.agents[0]!.personality += ' Sois bref.';
      writeFileSync(file, JSON.stringify(changed));
      expect(configFingerprint(loadCampaignConfig(file))).not.toBe(base);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(base).toMatch(/^[0-9a-f]{12}$/);
  });

  it('the print slot takes the bench printer only, and its own tools', () => {
    type Slot = { mcpServer: string; tools: string[]; autoApprove: string[] } | null;
    const withSlot = (slot: Slot, agentSlug = 'chef') =>
      refusal((c) => {
        const a = c.agents.find((x) => x.slug === agentSlug) as unknown as {
          printConnector: Slot;
        };
        a.printConnector = slot;
      });
    expect(
      withSlot({ mcpServer: 'office-printer', tools: ['request_print'], autoApprove: [] }),
    ).toContain('bench-printer');
    expect(
      withSlot({ mcpServer: 'bench-printer', tools: ['confirm_print'], autoApprove: [] }),
    ).not.toBe('(accepted)');
    expect(
      withSlot({
        mcpServer: 'bench-printer',
        tools: ['get_print_request'],
        autoApprove: ['request_print'],
      }),
    ).toContain('a tool approved without asking must be one the agent receives');
    expect(
      withSlot({ mcpServer: 'bench-printer', tools: ['request_print'], autoApprove: [] }, 'juge'),
    ).toContain('juge is not in the tested workspace: it prints nothing');
    expect(withSlot(null)).toBe('(accepted)');
  });

  it('blocked tools: never return_result (the product refuses to block it), never run_command (runCommand rules it)', () => {
    const blocking = (tools: string[]) =>
      refusal((c) => {
        (
          c.agents.find((x) => x.slug === 'chef') as unknown as { blockedTools: string[] }
        ).blockedTools = tools;
      });
    expect(blocking(['declare_verification'])).toBe('(accepted)');
    expect(blocking(['return_result'])).toContain('return_result cannot be blocked');
    expect(blocking(['run_command'])).toContain('run_command is ruled by runCommand');
    expect(blocking(['declare_verification', 'declare_verification'])).toContain(
      'chef blocks a tool twice',
    );
  });

  it('an agent receives the printer and the bench gave no records folder: refused before anything is written', async () => {
    const fresh = await freshInstanceDb();
    await expect(
      applyCampaignConfig(fresh.db, config, TEST_KEYS, {
        foldersRoot,
        installCommunitySkill: fakeCommunityInstaller(fresh.db).install,
      }),
    ).rejects.toThrow(/campaign_printer_records_dir/);
    expect(await fresh.db.select({ id: d.agents.id }).from(d.agents)).toEqual([]);
  });
});
