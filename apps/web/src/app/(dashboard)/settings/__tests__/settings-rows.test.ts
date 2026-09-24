// settings-rows.test.ts — les quatorze lignes de /settings et leur VALEUR
// COURANTE (S3, #231).
//
// Ce qui se prouve ici : une ligne affiche ce qui est VRAIMENT en base. Les
// sept réglages qui vivent dans la base sont donc écrits avec leurs vraies
// actions d'écriture, relus avec leurs vraies actions de lecture, et le
// résultat passe dans `buildSettingRows`. Aucune donnée de test n'est
// pré-fabriquée pour faire plaisir à l'assertion : « Asia/Singapore » sur la
// ligne Timezone n'est vrai que parce que `setWorkspaceTimezoneAction` l'a
// écrit et que `getWorkspaceTimezoneAction` l'a relu.
//
// Les réglages qui ne vivent PAS en base — le mode d'auth, le bind réseau, le
// secret du worker — viennent de la config et de l'environnement du processus.
// Il n'y a pas de vérité à relire dans la base pour eux : leur mapping est
// éprouvé directement, valeur d'entrée par valeur d'entrée.
//
// Mutations vérifiées : la valeur de Timezone remplacée par une constante →
// le cas « la ligne relit la base » rougit ; `UNREAD` remplacé par un défaut
// plausible ('Local only, 127.0.0.1') → le cas « une lecture ratée se dit »
// rougit ; l'ordre des groupes inversé → le cas « l'ordre des familles »
// rougit.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { entityMembers } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: seed?.userId ?? 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
  // `setInstallNotesAction` exige une appartenance « owner » : les notes
  // d'installation entrent dans le prompt de CHAQUE agent de l'espace.
  // `seedMinimal` ne pose pas cette ligne, donc on la pose ici.
  await testDb
    .insert(entityMembers)
    .values({ entityId: seed.entityId, userId: seed.userId, role: 'owner' });
});

type Actions = typeof import('@/lib/actions.ts');
type Rows = typeof import('../settings-rows.ts');

async function actions(): Promise<Actions> {
  return import('@/lib/actions.ts');
}
async function rowsModule(): Promise<Rows> {
  return import('../settings-rows.ts');
}

/** Le socle hors base : la config et l'environnement du processus. */
const OFF_DB = {
  authMode: 'local-trust' as const,
  workerSecretConfigured: true,
  security: null,
  network: null,
};

/**
 * Écrit de vraies valeurs, les relit avec les vraies actions, et rend les
 * lignes. Rien entre la base et l'assertion.
 */
async function rowsFromDb(overrides: Partial<Parameters<Rows['buildSettingRows']>[0]> = {}) {
  const a = await actions();
  const { buildSettingRows } = await rowsModule();

  const [
    autoRunPause,
    verification,
    proofRepair,
    runBudget,
    mcpServer,
    timezone,
    installNotes,
    workspaces,
    agents,
    root,
  ] = await Promise.all([
    a.getAutoRunPauseAction(),
    a.getVerificationSurfacesAction(),
    a.getProofRepairAction(),
    a.getRunBudgetAction(),
    a.getMcpServerSwitchAction(),
    a.getWorkspaceTimezoneAction(),
    a.getInstallNotesAction(),
    a.listWorkspacesAction(),
    a.listAgentsAction(),
    a.getRootConfigAction(),
  ]);

  expect(autoRunPause.ok, 'getAutoRunPauseAction').toBe(true);
  expect(verification.ok, 'getVerificationSurfacesAction').toBe(true);
  expect(proofRepair.ok, 'getProofRepairAction').toBe(true);
  expect(runBudget.ok, 'getRunBudgetAction').toBe(true);
  expect(mcpServer.ok, 'getMcpServerSwitchAction').toBe(true);
  expect(timezone.ok, 'getWorkspaceTimezoneAction').toBe(true);
  expect(installNotes.ok, 'getInstallNotesAction').toBe(true);
  expect(workspaces.ok, 'listWorkspacesAction').toBe(true);
  expect(agents.ok, 'listAgentsAction').toBe(true);
  expect(root.ok, 'getRootConfigAction').toBe(true);

  return buildSettingRows({
    ...OFF_DB,
    autoRunPause: autoRunPause.ok ? autoRunPause.data : null,
    verification: verification.ok ? verification.data : null,
    proofRepair: proofRepair.ok ? proofRepair.data : null,
    runBudget: runBudget.ok ? runBudget.data : null,
    mcpServer: mcpServer.ok ? mcpServer.data : null,
    timezone: timezone.ok ? timezone.data : null,
    installNotes: installNotes.ok ? installNotes.data : null,
    workspaces: workspaces.ok ? workspaces.data : [],
    agents: agents.ok ? agents.data : [],
    rootAgentId: root.ok ? root.data.rootAgentId : null,
    rootAutonomy: root.ok ? root.data.grants.autonomy : 'destructive_gate',
    ...overrides,
  });
}

function value(rows: Awaited<ReturnType<typeof rowsFromDb>>, id: string): string {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`aucune ligne ${id}`);
  return row.value;
}

describe('buildSettingRows — les lignes lisent la base @cap:installer-et-demarrer/moteur', () => {
  it('Timezone, Install notes, Auto-run brake et MCP server affichent ce qui a été écrit', async () => {
    const a = await actions();

    const tz = await a.setWorkspaceTimezoneAction({ timezone: 'Asia/Singapore' });
    expect(tz.ok, 'setWorkspaceTimezoneAction').toBe(true);
    const notes = await a.setInstallNotesAction('ComfyUI runs on :8188\nsecond line');
    expect(notes.ok, 'setInstallNotesAction').toBe(true);
    const brake = await a.setAutoRunPauseAction({ paused: true });
    expect(brake.ok, 'setAutoRunPauseAction').toBe(true);
    const mcp = await a.setMcpServerSwitchAction({ enabled: true });
    expect(mcp.ok, 'setMcpServerSwitchAction').toBe(true);

    const rows = await rowsFromDb();

    expect(value(rows, 'timezone')).toBe('Asia/Singapore');
    // Une seule ligne : la note est un texte libre, la liste en montre la première.
    expect(value(rows, 'install-notes')).toBe('ComfyUI runs on :8188');
    expect(value(rows, 'auto-run-brake')).toBe('Paused');
    expect(value(rows, 'mcp-server')).toBe('External clients reach the root agent');

    const brakeRow = rows.find((r) => r.id === 'auto-run-brake')!;
    const mcpRow = rows.find((r) => r.id === 'mcp-server')!;
    expect(brakeRow.toggle).toBe(true);
    expect(mcpRow.toggle).toBe(true);
  });

  it('les mêmes lignes suivent la base quand elle change en sens inverse', async () => {
    const a = await actions();

    expect((await a.setWorkspaceTimezoneAction({ timezone: 'Europe/Paris' })).ok).toBe(true);
    expect((await a.setInstallNotesAction('')).ok).toBe(true);
    expect((await a.setAutoRunPauseAction({ paused: false })).ok).toBe(true);
    expect((await a.setMcpServerSwitchAction({ enabled: false })).ok).toBe(true);

    const rows = await rowsFromDb();

    expect(value(rows, 'timezone')).toBe('Europe/Paris');
    expect(value(rows, 'install-notes')).toBe('Nothing yet');
    expect(value(rows, 'auto-run-brake')).toBe('Released');
    expect(value(rows, 'mcp-server')).toBe('Closed to external clients');

    expect(rows.find((r) => r.id === 'install-notes')!.tag).toEqual({
      variant: 'warn',
      label: 'EMPTY',
    });
    expect(rows.find((r) => r.id === 'auto-run-brake')!.toggle).toBe(false);
  });

  it('Verification surfaces nomme les surfaces cochées et les compte', async () => {
    const a = await actions();

    expect(
      (
        await a.setVerificationSurfacesAction({
          codeTask: true,
          cliRuntime: true,
          fileOps: true,
          shell: true,
        })
      ).ok,
    ).toBe(true);
    let rows = await rowsFromDb();
    expect(value(rows, 'verification')).toBe(
      'Coding tool, Claude Code / Codex agents, File tools, Commands and scripts',
    );
    expect(rows.find((r) => r.id === 'verification')!.tag).toEqual({
      variant: 'ok',
      label: '4 OF 4',
    });

    expect(
      (
        await a.setVerificationSurfacesAction({
          codeTask: true,
          cliRuntime: false,
          fileOps: false,
          shell: true,
        })
      ).ok,
    ).toBe(true);
    rows = await rowsFromDb();
    expect(value(rows, 'verification')).toBe('Coding tool, Commands and scripts');
    expect(rows.find((r) => r.id === 'verification')!.tag).toEqual({
      variant: 'warn',
      label: '2 OF 4',
    });
  });

  it('Run budget dit les plafonds ÉCRITS, et « aucun » pour zéro (#442)', async () => {
    const a = await actions();

    // Les défauts de la migration 0126 : le plafond que le runner appliquait déjà.
    let rows = await rowsFromDb();
    expect(value(rows, 'run-budget')).toBe('$2.00 per run, no time limit');

    expect((await a.setRunBudgetAction({ maxRunCostUsd: 5, maxRunHours: 1.5 })).ok).toBe(true);
    rows = await rowsFromDb();
    expect(value(rows, 'run-budget')).toBe('$5.00 per run, 1.5 h of work');

    expect((await a.setRunBudgetAction({ maxRunCostUsd: 0, maxRunHours: 0 })).ok).toBe(true);
    rows = await rowsFromDb();
    expect(value(rows, 'run-budget')).toBe('No cost ceiling, no time limit');

    // Au-delà des CHECK, l'action REFUSE — la base ne voit jamais la valeur.
    expect((await a.setRunBudgetAction({ maxRunCostUsd: 1001, maxRunHours: 0 })).ok).toBe(false);
    expect((await a.setRunBudgetAction({ maxRunCostUsd: 1, maxRunHours: 73 })).ok).toBe(false);
    rows = await rowsFromDb();
    expect(value(rows, 'run-budget')).toBe('No cost ceiling, no time limit');

    // Remis aux défauts pour les cas suivants.
    expect((await a.setRunBudgetAction({ maxRunCostUsd: 2, maxRunHours: 0 })).ok).toBe(true);
  });

  it('Repair turns dit la borne ÉCRITE, y compris zéro', async () => {
    const a = await actions();

    // Le défaut de la colonne, sans rien écrire : la borne de #375.
    let rows = await rowsFromDb();
    expect(value(rows, 'repair-turns')).toBe('One repair turn');
    expect(rows.find((r) => r.id === 'repair-turns')!.tag).toEqual({
      variant: 'ok',
      label: '1 MAX',
    });

    // Zéro : le comportement d'avant #375, et la ligne le DIT en toutes
    // lettres plutôt que d'afficher un « 0 » que personne n'interprète.
    expect((await a.setProofRepairAction({ repairAttempts: 0 })).ok).toBe(true);
    rows = await rowsFromDb();
    expect(value(rows, 'repair-turns')).toBe('None, a failed proof ends the run');
    expect(rows.find((r) => r.id === 'repair-turns')!.tag!.label).toBe('0 MAX');

    expect((await a.setProofRepairAction({ repairAttempts: 3 })).ok).toBe(true);
    rows = await rowsFromDb();
    expect(value(rows, 'repair-turns')).toBe('Up to 3 repair turns');

    // Au-delà du plafond, l'action REFUSE — la base ne voit jamais la valeur.
    const refus = await a.setProofRepairAction({ repairAttempts: 4 });
    expect(refus.ok).toBe(false);
    rows = await rowsFromDb();
    expect(value(rows, 'repair-turns')).toBe('Up to 3 repair turns');

    // Remis au défaut pour les cas suivants.
    expect((await a.setProofRepairAction({ repairAttempts: 1 })).ok).toBe(true);
  });

  it('les budgets anti-boucle viennent du code qui les applique, jamais recopiés', async () => {
    const a = await actions();
    const { DEFAULT_LIMITS } = await import('@nodal-agents/orchestration');
    const vue = await a.getProofRepairAction();
    expect(vue.ok).toBe(true);
    if (!vue.ok) return;
    // Les MÊMES nombres que le runner oppose à un job : une recopie dans
    // l'écran finirait par dire le contraire de la machine.
    expect(vue.data.budgets).toEqual({
      resumesPerRun: DEFAULT_LIMITS.maxChains,
      toolCallsPerTurn: DEFAULT_LIMITS.maxToolCallsPerTurn,
      delegationDepth: DEFAULT_LIMITS.maxDelegationDepth,
    });
  });

  it('Workspaces nomme l’espace actif lu en base', async () => {
    const a = await actions();
    const list = await a.listWorkspacesAction();
    expect(list.ok).toBe(true);
    const active = list.ok ? list.data.find((w) => w.active) : undefined;

    const rows = await rowsFromDb();
    const row = rows.find((r) => r.id === 'workspaces')!;

    if (active) {
      expect(row.value).toContain(active.name);
      expect(row.tag).toEqual({ variant: 'ok', label: 'ACTIVE' });
    } else {
      expect(row.tag).toEqual({ variant: 'warn', label: 'NONE' });
    }
  });

  it('les quinze lignes existent, groupées dans l’ordre Access, Safety, Workspace, Advanced', async () => {
    const rows = await rowsFromDb({ authMode: 'local-auth' });

    expect(rows.map((r) => r.id)).toEqual([
      'sign-in',
      'network',
      'password',
      'worker-secret',
      'auto-run-brake',
      'verification',
      'repair-turns',
      'run-budget',
      'root-agent',
      'mcp-server',
      'timezone',
      'install-notes',
      'workspaces',
      'urls',
      'session',
    ]);
    expect(rows.map((r) => r.group)).toEqual([
      'access',
      'access',
      'access',
      'access',
      'safety',
      'safety',
      'safety',
      'safety',
      'safety',
      'safety',
      'workspace',
      'workspace',
      'workspace',
      'advanced',
      'advanced',
    ]);
  });

  it('sans mot de passe à changer, la ligne Password n’existe pas', async () => {
    for (const mode of ['local-trust', 'bearer-token'] as const) {
      const rows = await rowsFromDb({ authMode: mode });
      expect(rows.map((r) => r.id)).not.toContain('password');
      expect(rows).toHaveLength(14);
    }
  });
});

describe('buildSettingRows — la config et l’environnement @cap:installer-et-demarrer/moteur', () => {
  const BASE = {
    authMode: 'local-trust' as const,
    workerSecretConfigured: true,
    security: null,
    network: null,
    autoRunPause: null,
    verification: null,
    proofRepair: null,
    runBudget: null,
    mcpServer: null,
    timezone: null,
    installNotes: null,
    workspaces: [],
    agents: [],
    rootAgentId: null,
    rootAutonomy: 'destructive_gate' as const,
  };

  it('Sign-in dit le mode en vigueur, et sa pastille', async () => {
    const { buildSettingRows } = await rowsModule();
    const cas = [
      { authMode: 'local-auth' as const, value: 'Email and password', label: 'PASSWORD' },
      { authMode: 'local-trust' as const, value: 'No sign-in', label: 'NO AUTH' },
      { authMode: 'bearer-token' as const, value: 'Bearer token', label: 'TOKEN' },
    ];
    for (const c of cas) {
      const row = buildSettingRows({ ...BASE, authMode: c.authMode }).find(
        (r) => r.id === 'sign-in',
      )!;
      expect(row.value).toBe(c.value);
      expect(row.tag!.label).toBe(c.label);
    }
  });

  it('Sign-in ajoute Google quand la config le porte', async () => {
    const { buildSettingRows } = await rowsModule();
    const row = buildSettingRows({
      ...BASE,
      authMode: 'local-auth',
      security: {
        runtimeMode: 'local-auth',
        configuredMode: 'local-auth',
        googleConfigured: true,
        googleAvailableInRuntime: true,
        configPathExists: true,
      },
    }).find((r) => r.id === 'sign-in')!;
    expect(row.value).toBe('Email and password, Google sign-in on');
  });

  it('Network access montre l’adresse que les autres appareils doivent taper', async () => {
    const { buildSettingRows } = await rowsModule();
    const lan = buildSettingRows({
      ...BASE,
      network: {
        configuredBind: 'lan',
        runtimeBind: 'lan',
        lanAddresses: ['192.168.50.197'],
        webPort: 3000,
        configPathExists: true,
      },
    }).find((r) => r.id === 'network')!;
    expect(lan.value).toBe('http://192.168.50.197:3000');
    expect(lan.tag).toEqual({ variant: 'warn', label: 'LAN' });

    const loopback = buildSettingRows({
      ...BASE,
      network: {
        configuredBind: 'loopback',
        runtimeBind: 'loopback',
        lanAddresses: [],
        webPort: 3000,
        configPathExists: true,
      },
    }).find((r) => r.id === 'network')!;
    expect(loopback.value).toBe('Local only, 127.0.0.1');
    expect(loopback.tag).toEqual({ variant: 'ok', label: 'LOCAL' });
  });

  it('Worker secret dit ce qui casse quand il manque', async () => {
    const { buildSettingRows } = await rowsModule();
    const missing = buildSettingRows({ ...BASE, workerSecretConfigured: false }).find(
      (r) => r.id === 'worker-secret',
    )!;
    expect(missing.value).toBe('Missing, runner calls will 403');
    expect(missing.tag).toEqual({ variant: 'warn', label: 'MISSING' });
  });

  it('une lecture qui a échoué se DIT, elle ne se remplace pas par un défaut plausible', async () => {
    const { buildSettingRows } = await rowsModule();
    const rows = buildSettingRows(BASE);
    for (const id of ['network', 'auto-run-brake', 'verification', 'timezone', 'install-notes']) {
      expect(rows.find((r) => r.id === id)!.value, id).toBe('Could not be read');
    }
  });

  it('ROOT agent nomme l’agent et son niveau d’autonomie', async () => {
    const { buildSettingRows } = await rowsModule();
    const agent = {
      id: 'a1',
      entityId: 'e1',
      name: 'Alfred',
      slug: 'alfred',
      personality: '',
      model: null,
      llmKeyId: null,
      active: true,
      isDefault: true,
      role: 'orchestrator',
      avatarUrl: null,
      createdAt: null,
      telegramBotToken: null,
    } as Parameters<typeof buildSettingRows>[0]['agents'][number];

    const withRoot = buildSettingRows({
      ...BASE,
      agents: [agent],
      rootAgentId: 'a1',
      rootAutonomy: 'destructive_gate',
    }).find((r) => r.id === 'root-agent')!;
    expect(withRoot.value).toBe('Alfred, autonomous, gate destructive');

    const withoutRoot = buildSettingRows(BASE).find((r) => r.id === 'root-agent')!;
    expect(withoutRoot.value).toBe('No ROOT agent yet');
  });
});

describe('filterSettingRows @cap:installer-et-demarrer/moteur', () => {
  it('réduit la liste aux lignes dont le nom contient le filtre, sans casse', async () => {
    const { buildSettingRows, filterSettingRows } = await rowsModule();
    const rows = buildSettingRows({
      authMode: 'local-auth',
      workerSecretConfigured: true,
      security: null,
      network: null,
      autoRunPause: null,
      verification: null,
      proofRepair: null,
      runBudget: null,
      mcpServer: null,
      timezone: null,
      installNotes: null,
      workspaces: [],
      agents: [],
      rootAgentId: null,
      rootAutonomy: 'destructive_gate',
    });

    expect(filterSettingRows(rows, 'net').map((r) => r.id)).toEqual(['network']);
    // « Network access » contient « work » : le filtre porte sur le nom
    // entier, pas sur son premier mot.
    expect(filterSettingRows(rows, 'WORK').map((r) => r.id)).toEqual([
      'network',
      'worker-secret',
      'workspaces',
    ]);
    expect(filterSettingRows(rows, 'zzz')).toHaveLength(0);
    expect(filterSettingRows(rows, '   ')).toHaveLength(rows.length);
  });
});
