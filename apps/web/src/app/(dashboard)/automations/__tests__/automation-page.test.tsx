// automation-page.test.tsx — LA page d'une automatisation (#202).
//
// Ce que ce fichier prouve, sur une vraie base (PGlite) et sur ce que la page
// rend vraiment (invariant #5) :
//
//   1. la carte de réglages porte les CINQ lignes de la planche B, remplies
//      depuis une automatisation lue en base — l'agent, le déclencheur, la
//      tâche entière, la notification, le dernier run ;
//   2. les runs listés sont ceux de CETTE automatisation et d'aucune autre :
//      une seconde routine, avec ses propres runs, n'apparaît nulle part ;
//   3. un run reconnu par sa seule PROVENANCE (colonne `schedule_id` vidée par
//      une suppression) reste rattaché à sa routine ;
//   4. le compteur de fenêtre est une FENÊTRE : un run vieux de soixante jours
//      se lit dans la liste sans compter dans « over 30 days » ;
//   5. un webhook ouvre la même page, ses runs se reconnaissent à son slug, et
//      ses lignes mènent à `/jobs/<id>` et non à `/scheduled/<id>` ;
//   6. la page ne dessine ni « Run now » ni « Edit » pour un webhook — aucune
//      action serveur ne les porte (invariant #4).
//
// Mutation vérifiée avant d'écrire la suite : dans `getAutomationAction`,
// retirer du filtre des runs le `or(eq(schedule_id), provenance)` d'une routine
// (ne garder que `channel = 'cron'`) rend les tests 2 et 3 rouges — les runs de
// l'autre routine entrent dans la liste. De même, remplacer le slug du webhook
// par `channel = 'webhook'` seul fait entrer les runs d'un autre webhook.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agentSchedules, scheduleState, webhookTriggers, eq } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
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
      userId: 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...rest }, children),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/automations',
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Les contrôles globaux de l'en-tête ne sont pas le sujet : chacun appelle son
// action serveur, et les monter ici n'aurait rien prouvé sur la page.
vi.mock('@/components/ui/SearchBox', () => ({ default: () => null }));
vi.mock('@/components/ui/ThemeToggle', () => ({ default: () => null }));
vi.mock('@/components/NotificationsBell', () => ({ default: () => null }));

import { getAutomationAction, type AutomationView } from '@/lib/actions.ts';
import AutomationScreen from '../[id]/AutomationScreen.tsx';
import ScheduleRow from '../ScheduleRow.tsx';
import WebhookRow from '../WebhookRow.tsx';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Les deux routines et le webhook, tels que le seed les écrit. */
let digestId: string;
let cleanupId: string;
let hookId: string;
let otherHookId: string;
/** Les runs de « Weekly digest », du plus récent au plus ancien. */
let digestRunIds: string[];
/** Les runs qui ne sont PAS les siens et ne doivent apparaître nulle part. */
let etrangerRunIds: string[];
let hookRunId: string;
/** Les automatisations d'une AUTRE entité — jamais servies à cette session. */
let scheduleVoisinId: string;
let hookVoisinId: string;

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const now = Date.now();

  const [digest] = await testDb
    .insert(agentSchedules)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      name: 'Weekly digest',
      cronExpr: '0 9 * * 1',
      timezone: 'Europe/Paris',
      task: 'Write the weekly digest from the last seven days of activity, then send it.',
      active: true,
      notifyOnSuccess: true,
      notifyChannel: 'telegram',
      nextRun: new Date(now + 2 * 60 * MINUTE),
    })
    .returning();
  if (!digest) throw new Error('seed: schedule');
  digestId = digest.id;

  const [cleanup] = await testDb
    .insert(agentSchedules)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      name: 'Nightly cleanup',
      cronExpr: '0 2 * * *',
      task: 'Delete the temporary files older than a week.',
      active: true,
    })
    .returning();
  if (!cleanup) throw new Error('seed: other schedule');
  cleanupId = cleanup.id;

  // Trois runs de « Weekly digest » dans la fenêtre, plus un vieux de soixante
  // jours. Le TROISIÈME ne porte plus la colonne `schedule_id` : seule sa
  // provenance le rattache, comme après la suppression puis la recréation d'une
  // routine.
  const digestRuns = await testDb
    .insert(agentJobs)
    .values([
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'cron',
        task: 'digest run 1',
        status: 'completed',
        scheduleId: digest.id,
        totalCostUsd: 0.03,
        createdAt: new Date(now - 60 * MINUTE),
        completedAt: new Date(now - 58 * MINUTE),
        triggerContext: {
          type: 'cron' as const,
          scheduleName: 'Weekly digest',
          prevRunAt: null,
          scheduleId: digest.id,
        },
      },
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'cron',
        task: 'digest run 2',
        status: 'completed',
        scheduleId: digest.id,
        totalCostUsd: 0.05,
        createdAt: new Date(now - 8 * DAY),
        completedAt: new Date(now - 8 * DAY + 3 * MINUTE),
      },
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'cron',
        task: 'digest run 3, provenance only',
        status: 'failed',
        scheduleId: null,
        totalCostUsd: 0.04,
        createdAt: new Date(now - 15 * DAY),
        triggerContext: {
          type: 'cron' as const,
          scheduleName: 'Weekly digest',
          prevRunAt: null,
          scheduleId: digest.id,
        },
      },
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'cron',
        task: 'digest run 4, outside the window',
        status: 'completed',
        scheduleId: digest.id,
        totalCostUsd: 1,
        createdAt: new Date(now - 60 * DAY),
      },
    ])
    .returning({ id: agentJobs.id });
  digestRunIds = digestRuns.map((r) => r.id);

  // Ce que « Weekly digest » a RETENU de ses runs. « Nightly cleanup » n'a rien
  // noté : les deux cas se lisent, celui qui montre l'état et celui qui n'en a
  // pas.
  await testDb.insert(scheduleState).values([
    {
      scheduleId: digest.id,
      key: 'last_announced_version',
      value: 'v0.8.8 (2026-08-28)',
    },
    { scheduleId: digest.id, key: 'last_checked_at', value: '2026-09-08T01:00:30Z' },
  ]);

  const cleanupRuns = await testDb
    .insert(agentJobs)
    .values([
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'cron',
        task: 'cleanup run 1',
        status: 'completed',
        scheduleId: cleanup.id,
        totalCostUsd: 1.5,
        createdAt: new Date(now - 30 * MINUTE),
      },
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'cron',
        task: 'cleanup run 2',
        status: 'completed',
        scheduleId: cleanup.id,
        totalCostUsd: 1.5,
        createdAt: new Date(now - 2 * DAY),
      },
    ])
    .returning({ id: agentJobs.id });

  const [hook] = await testDb
    .insert(webhookTriggers)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      name: 'Invoice received',
      slug: 'invoice-received',
      taskTemplate: 'Read the invoice in the payload and file it.',
      secret: 'a-secret-never-read-back',
      active: true,
      triggerCount: 4,
      lastTriggeredAt: new Date(now - 10 * MINUTE),
    })
    .returning();
  if (!hook) throw new Error('seed: webhook');
  hookId = hook.id;

  const [otherHook] = await testDb
    .insert(webhookTriggers)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      name: 'Form submitted',
      slug: 'form-submitted',
      taskTemplate: 'Answer the form.',
      secret: 'another-secret',
      active: true,
    })
    .returning();
  if (!otherHook) throw new Error('seed: other webhook');
  otherHookId = otherHook.id;

  const hookRuns = await testDb
    .insert(agentJobs)
    .values([
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'webhook',
        task: 'invoice run',
        status: 'completed',
        totalCostUsd: 0.02,
        createdAt: new Date(now - 11 * MINUTE),
        triggerContext: {
          type: 'webhook' as const,
          webhookName: 'Invoice received',
          slug: 'invoice-received',
          triggeredAt: new Date(now - 11 * MINUTE).toISOString(),
        },
      },
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'webhook',
        task: 'form run',
        status: 'completed',
        totalCostUsd: 0.09,
        createdAt: new Date(now - 12 * MINUTE),
        triggerContext: {
          type: 'webhook' as const,
          webhookName: 'Form submitted',
          slug: 'form-submitted',
          triggeredAt: new Date(now - 12 * MINUTE).toISOString(),
        },
      },
    ])
    .returning({ id: agentJobs.id });
  hookRunId = hookRuns[0]?.id ?? '';
  etrangerRunIds = [...cleanupRuns.map((r) => r.id), hookRuns[1]?.id ?? ''];

  // Une SECONDE entité, avec son agent et ses automatisations. La session des
  // tests reste celle de la première (voir les doubles de `requireAuth` et
  // `applyActiveEntity` plus haut, qui rendent tous deux `seed.entityId`) :
  // tout ce qui est semé ici appartient à quelqu'un d'autre.
  const voisin = await seedMinimal(testDb);
  const [scheduleVoisin] = await testDb
    .insert(agentSchedules)
    .values({
      entityId: voisin.entityId,
      agentId: voisin.agentId,
      name: 'Another tenant digest',
      cronExpr: '0 9 * * 1',
      task: 'Not ours to read.',
      active: true,
    })
    .returning();
  if (!scheduleVoisin) throw new Error('seed: schedule of the other entity');
  scheduleVoisinId = scheduleVoisin.id;

  const [hookVoisin] = await testDb
    .insert(webhookTriggers)
    .values({
      entityId: voisin.entityId,
      agentId: voisin.agentId,
      name: 'Another tenant hook',
      slug: 'another-tenant-hook',
      taskTemplate: 'Not ours to read.',
      secret: 'not-ours',
      active: true,
    })
    .returning();
  if (!hookVoisin) throw new Error('seed: webhook of the other entity');
  hookVoisinId = hookVoisin.id;
});

let container: HTMLDivElement;
/** `null` tant qu'un cas n'a rien monté — les cas « moteur » n'ont pas d'écran. */
let root: Root | null = null;

async function render(node: ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
  });
}

afterEach(async () => {
  if (root === null) return;
  const monte = root;
  root = null;
  await act(async () => {
    monte.unmount();
  });
  document.body.innerHTML = '';
});

/** L'automatisation telle que la page la lit, ou l'erreur qui la remplace. */
async function load(id: string): Promise<AutomationView> {
  const result = await getAutomationAction(id);
  if (!result.ok) throw new Error(`getAutomationAction: ${result.message}`);
  return result.data;
}

/** Les lignes de la carte de réglages, libellé → valeur. */
function facts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of container.querySelectorAll('[data-testid="automation-fact"]')) {
    const label = row.querySelector('[data-testid="fact-label"]')?.textContent?.trim() ?? '';
    out[label] = row.querySelector('[data-testid="fact-value"]')?.textContent?.trim() ?? '';
  }
  return out;
}

/** Les adresses de toutes les lignes de runs rendues. */
function runLinks(): string[] {
  const list = container.querySelector('[data-testid="automation-runs"]');
  return [...(list?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href') ?? '');
}

function buttonLabels(): string[] {
  const bar = container.querySelector('[data-testid="automation-actions"]');
  return [...(bar?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim() ?? '');
}

describe('les runs d’une automatisation @cap:planifier-une-tache/moteur', () => {
  it('ne rend que les siens, colonne ou provenance, et jamais ceux d’une autre', async () => {
    const view = await load(digestId);
    expect(view.kind).toBe('schedule');
    const lus = view.runs.map((r) => r.id);
    // Les quatre runs de la routine, du plus récent au plus ancien, y compris
    // celui que seule sa provenance rattache.
    expect(lus).toEqual(digestRunIds);
    for (const etranger of etrangerRunIds) {
      expect(lus).not.toContain(etranger);
    }

    // Et l'autre routine a bien les siens : sans cela, un filtre qui ne rendrait
    // jamais rien passerait l'assertion ci-dessus sans broncher.
    const autre = await load(cleanupId);
    expect(autre.runs).toHaveLength(2);
    for (const id of autre.runs.map((r) => r.id)) {
      expect(digestRunIds).not.toContain(id);
    }
  });

  it('compte sur la FENÊTRE, pas sur tout l’historique', async () => {
    const view = await load(digestId);
    // Quatre runs listés, trois comptés : le quatrième a soixante jours.
    expect(view.runs).toHaveLength(4);
    expect(view.window.days).toBe(30);
    expect(view.window.runs).toBe(3);
    expect(view.window.costUsd).toBeCloseTo(0.12, 4);
  });

  it('rattache les runs d’un webhook à SON slug', async () => {
    const view = await load(hookId);
    expect(view.kind).toBe('webhook');
    expect(view.runs.map((r) => r.id)).toEqual([hookRunId]);
    for (const etranger of etrangerRunIds) {
      expect(view.runs.map((r) => r.id)).not.toContain(etranger);
    }
    // Et l'autre webhook a bien les siens : sans cela, le filtre pourrait ne
    // rien rendre du tout et le test ci-dessus passerait quand même.
    const autre = await load(otherHookId);
    expect(autre.runs).toHaveLength(1);
    expect(autre.runs[0]?.id).not.toBe(hookRunId);
  });

  it('ne sert pas une automatisation inconnue comme une page vide', async () => {
    const result = await getAutomationAction('11111111-1111-4111-8111-111111111111');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });

  it('ne sert pas l’automatisation d’une AUTRE entité, même avec son id exact', async () => {
    // L'id existe, la ligne existe, et elle n'appartient pas à cette session.
    // Elle doit être introuvable — pas « vide », pas « sans runs » : un id
    // valide qui rendrait une page à moitié remplie dirait déjà que la chose
    // existe, et c'est déjà en dire trop.
    for (const id of [scheduleVoisinId, hookVoisinId]) {
      const result = await getAutomationAction(id);
      expect(result.ok, `l'automatisation ${id} n'est pas servie`).toBe(false);
      if (!result.ok) expect(result.code).toBe('not_found');
    }
    // Les deux lignes sont bien LÀ, et lisibles par leur id seul : sans cette
    // vérification, le test passerait sur une base où rien n'a été semé, ou sur
    // un chargeur qui refuserait tout.
    const semees = await testDb
      .select({ id: agentSchedules.id, entityId: agentSchedules.entityId })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, scheduleVoisinId));
    expect(semees).toHaveLength(1);
    expect(semees[0]?.entityId).not.toBe(seed.entityId);

    // Le contraste qui rend le cas discriminant : le MÊME chargeur, appelé de
    // la MÊME façon, ouvre les automatisations de cette session. Seule
    // l'appartenance sépare les deux réponses.
    for (const id of [digestId, hookId]) {
      expect((await getAutomationAction(id)).ok, `les nôtres s'ouvrent (${id})`).toBe(true);
    }
  });

  it('ne rend jamais le secret d’un webhook', async () => {
    const view = await load(hookId);
    expect(JSON.stringify(view)).not.toContain('a-secret-never-read-back');
    if (view.kind === 'webhook') expect(view.webhook.hasSecret).toBe(true);
  });
});

describe('la page d’une routine @cap:planifier-une-tache/ecran', () => {
  it('rend les cinq lignes de réglages depuis la base', async () => {
    const view = await load(digestId);
    await render(<AutomationScreen view={view} agents={[]} />);

    expect(Object.keys(facts())).toEqual(['Agent', 'Trigger', 'Task', 'Notify', 'Last run']);
    const f = facts();
    expect(f.Agent).toBe('Test Agent');
    expect(f.Trigger).toContain('Every Mon at 09:00');
    expect(f.Trigger).toContain('Europe/Paris');
    expect(f.Trigger).toContain('next run');
    // La tâche ENTIÈRE, pas son premier mot.
    expect(f.Task).toBe(
      'Write the weekly digest from the last seven days of activity, then send it.',
    );
    expect(f.Notify).toBe('Telegram · on success');
    // Le dernier run : sa date, son verdict, sa durée, son coût.
    expect(f['Last run']).toContain('Done');
    expect(f['Last run']).toContain('2 min');
    expect(f['Last run']).toContain('$0.03');
  });

  it('liste SES runs, et mène chacun à sa page de run', async () => {
    const view = await load(digestId);
    await render(<AutomationScreen view={view} agents={[]} />);

    expect(runLinks()).toEqual(digestRunIds.map((id) => `/scheduled/${id}`));
    for (const etranger of etrangerRunIds) {
      expect(runLinks()).not.toContain(`/scheduled/${etranger}`);
      expect(runLinks()).not.toContain(`/jobs/${etranger}`);
    }
  });

  it('annonce les runs comptés sur la fenêtre et renvoie au reste', async () => {
    const view = await load(digestId);
    await render(<AutomationScreen view={view} agents={[]} />);

    expect(container.querySelector('[data-testid="runs-headline"]')?.textContent).toBe(
      'Runs · 3 · $0.12 over 30 days',
    );
    // « See all » mène à Activity filtrée sur l'AGENT, jamais à /scheduled :
    // cette page est retirée (#202), et Activity ne sait pas filtrer par
    // automatisation. Le libellé nomme donc ce qu'on y trouvera vraiment.
    const seeAll = container.querySelector('[data-testid="runs-see-all"]');
    expect(seeAll?.getAttribute('href')).toBe(`/logs?agent=${seed.agentId}`);
    expect(seeAll?.textContent).toContain('See all runs of Test Agent');
    expect(container.innerHTML).not.toContain('href="/scheduled"');
  });

  it('montre ce que la routine a RETENU, au-dessus de ses runs', async () => {
    // Cet état décide s'il y aura du travail au prochain run. La page
    // /scheduled qui le montrait est retirée (#202) : celle-ci est le seul
    // écran qui reste, et le perdre ferait republier une annonce déjà publiée
    // (08/09/2026).
    const view = await load(digestId);
    await render(<AutomationScreen view={view} agents={[]} />);

    const etat = container.querySelector('[data-testid="routine-state"]');
    expect(etat, 'la routine a un état, et il est rendu').not.toBeNull();
    expect(etat?.textContent).toContain('last_announced_version');
    expect(etat?.textContent).toContain('v0.8.8 (2026-08-28)');
    // La valeur exacte reste atteignable au survol, même tronquée à l'écran :
    // c'est elle que la routine compare.
    expect(etat?.querySelector('[title="v0.8.8 (2026-08-28)"]')).not.toBeNull();
  });

  it('ne rend PAS de bloc d’état pour une routine qui n’a rien retenu', async () => {
    const view = await load(cleanupId);
    await render(<AutomationScreen view={view} agents={[]} />);
    expect(container.querySelector('[data-testid="routine-state"]')).toBeNull();
  });

  it('porte le retour vers la liste et les trois gestes de la planche', async () => {
    const view = await load(digestId);
    await render(<AutomationScreen view={view} agents={[]} />);

    expect(
      container.querySelector('[data-testid="back-to-automations"]')?.getAttribute('href'),
    ).toBe('/automations');
    expect(buttonLabels()).toEqual(['Run now', 'Pause', 'Edit']);
  });
});

describe('la liste des automations ouvre chaque carte @cap:planifier-une-tache/ecran', () => {
  it('fait du nom d’une routine un lien vers sa page, sans cesser d’être le titre', async () => {
    const view = await load(digestId);
    if (view.kind !== 'schedule') throw new Error('schedule attendu');
    await render(<ScheduleRow schedule={view.schedule} agents={[]} />);

    const titre = container.querySelector('h3');
    expect(titre?.textContent?.trim()).toBe('Weekly digest');
    expect(titre?.querySelector('a')?.getAttribute('href')).toBe(`/automations/${digestId}`);
  });

  it('fait de même pour un webhook', async () => {
    const view = await load(hookId);
    if (view.kind !== 'webhook') throw new Error('webhook attendu');
    await render(<WebhookRow webhook={view.webhook} onRevealed={() => {}} />);

    const titre = container.querySelector('h3');
    expect(titre?.textContent?.trim()).toBe('Invoice received');
    expect(titre?.querySelector('a')?.getAttribute('href')).toBe(`/automations/${hookId}`);
  });
});

describe('la page d’un webhook @cap:declencher-sur-evenement/ecran', () => {
  it('dit ce qui le déclenche, sans jamais écrire son secret', async () => {
    const view = await load(hookId);
    await render(<AutomationScreen view={view} agents={[]} />);

    const f = facts();
    expect(Object.keys(f)).toEqual(['Agent', 'Trigger', 'Task', 'Notify', 'Last run']);
    expect(f.Trigger).toContain('POST /webhooks/invoice-received');
    expect(f.Trigger).toContain('4 fires');
    expect(container.textContent).not.toContain('a-secret-never-read-back');
    expect(f.Task).toBe('Read the invoice in the payload and file it.');
    expect(f.Notify).toBe('Off');
  });

  it('mène ses runs à /jobs, et ne promet ni « Run now » ni « Edit »', async () => {
    const view = await load(hookId);
    await render(<AutomationScreen view={view} agents={[]} />);

    expect(runLinks()).toEqual([`/jobs/${hookRunId}`]);
    // Aucune action serveur ne déclenche un webhook depuis le tableau de bord,
    // et `WebhookForm` n'a pas de mode édition : les dessiner mentirait.
    expect(buttonLabels()).toEqual(['Pause', 'Rotate secret']);
  });
});
