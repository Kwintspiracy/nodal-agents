/**
 * settings-rows.ts — le MODÈLE DE VUE de la liste des réglages (S3, #231).
 *
 * Une seule fonction pure : elle prend ce que les actions ont lu (config,
 * base), et rend une ligne par réglage — son nom, sa VALEUR COURANTE en
 * toutes lettres, sa pastille, l'état de son interrupteur. La page ne fait
 * qu'afficher ce que cette fonction dit.
 *
 * Elle est ici, hors du composant, pour une raison : « la ligne Timezone
 * affiche Asia/Singapore » est un fait qui se teste sur des données réelles,
 * sans rendre un écran. Tout ce qui a demandé une décision — quelle valeur on
 * montre quand une lecture a échoué, quelle pastille pour quel état — se lit
 * et se prouve à un seul endroit.
 *
 * RÈGLE : aucune valeur inventée. Quand une lecture a échoué, la ligne le dit
 * (« Could not be read ») au lieu d'afficher un défaut plausible — invariant
 * #4, pas de repli silencieux. La planche dessine « Last changed 12 days ago »
 * sur la ligne Password : ce fait n'existe nulle part dans le produit, donc il
 * n'est pas affiché.
 */

import type { AutonomyLevel } from '@nodal-agents/shared';
import { VERIFICATION_SURFACE_KEYS } from '@nodal-agents/shared';
import type {
  AgentRow,
  AutoRunPauseView,
  McpServerSwitchView,
  NetworkView,
  SecurityView,
  ProofRepairView,
  RunBudgetView,
  VerificationSurfacesView,
  WorkspaceRow,
} from '@/lib/actions.ts';
import { AUTONOMY_OPTIONS } from '@/lib/autonomy.ts';
import { VERIFICATION_SURFACE_LABELS } from '@/lib/verification-runs-view.ts';
import { runBudgetValue } from './run-budget-copy.ts';

export type SettingGroup = 'access' | 'safety' | 'workspace' | 'advanced';

export type SettingId =
  | 'sign-in'
  | 'network'
  | 'password'
  | 'worker-secret'
  | 'auto-run-brake'
  | 'verification'
  | 'repair-turns'
  | 'run-budget'
  | 'root-agent'
  | 'mcp-server'
  | 'timezone'
  | 'install-notes'
  | 'workspaces'
  | 'urls'
  | 'session';

export type SettingRow = {
  id: SettingId;
  group: SettingGroup;
  /** Name in the list, and title of the panel. */
  name: string;
  /** One line under the panel title. */
  lede: string;
  /** The value in force, read from the config or the DB. */
  value: string;
  /** The mini pill the board draws on some rows. */
  tag?: { variant: 'ok' | 'warn'; label: string };
  /** The switch the board draws on two rows — a picture of the state, never a control. */
  toggle?: boolean;
};

/** Everything the list needs, gathered by the page from its actions. */
export type SettingsSource = {
  authMode: 'local-trust' | 'local-auth' | 'bearer-token';
  workerSecretConfigured: boolean;
  security: SecurityView | null;
  network: NetworkView | null;
  autoRunPause: AutoRunPauseView | null;
  verification: VerificationSurfacesView | null;
  proofRepair: ProofRepairView | null;
  runBudget: RunBudgetView | null;
  mcpServer: McpServerSwitchView | null;
  timezone: { timezone: string; isExplicit: boolean } | null;
  installNotes: string | null;
  workspaces: WorkspaceRow[];
  agents: AgentRow[];
  rootAgentId: string | null;
  rootAutonomy: AutonomyLevel;
};

/** Ce qu'on écrit quand l'action a échoué — jamais un défaut qui a l'air vrai. */
const UNREAD = 'Could not be read';

const AUTH_MODE_WORDS: Record<SettingsSource['authMode'], string> = {
  'local-auth': 'Email and password',
  'local-trust': 'No sign-in',
  'bearer-token': 'Bearer token',
};

const AUTH_MODE_TAG: Record<SettingsSource['authMode'], SettingRow['tag']> = {
  'local-auth': { variant: 'ok', label: 'PASSWORD' },
  'bearer-token': { variant: 'ok', label: 'TOKEN' },
  'local-trust': { variant: 'warn', label: 'NO AUTH' },
};

function signInValue(src: SettingsSource): string {
  const words = AUTH_MODE_WORDS[src.authMode];
  if (src.security?.googleConfigured) return `${words}, Google sign-in on`;
  return words;
}

function networkValue(net: NetworkView | null): string {
  if (!net) return UNREAD;
  if (net.configuredBind === 'loopback') return 'Local only, 127.0.0.1';
  const first = net.lanAddresses[0];
  return first ? `http://${first}:${net.webPort}` : 'LAN, 0.0.0.0';
}

function verificationValue(view: VerificationSurfacesView | null): string {
  if (!view) return UNREAD;
  const on = VERIFICATION_SURFACE_KEYS.filter((k) => view.surfaces[k]);
  if (on.length === 0) return 'Nothing is verified';
  return on.map((k) => VERIFICATION_SURFACE_LABELS[k].label).join(', ');
}

function rootAgentValue(src: SettingsSource): string {
  const root = src.agents.find((a) => a.id === src.rootAgentId);
  if (!root) return 'No ROOT agent yet';
  const autonomy = AUTONOMY_OPTIONS.find((o) => o.value === src.rootAutonomy);
  return autonomy ? `${root.name}, ${autonomy.name.toLowerCase()}` : root.name;
}

function installNotesValue(notes: string | null): string {
  if (notes === null) return UNREAD;
  const first = notes.trim().split('\n')[0]?.trim() ?? '';
  if (first === '') return 'Nothing yet';
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

function workspacesValue(rows: WorkspaceRow[]): string {
  const active = rows.find((w) => w.active);
  if (!active) return rows.length === 0 ? 'No workspace found' : `${rows.length} workspaces`;
  return rows.length > 1 ? `${active.name}, ${active.role}, ${rows.length} total` : active.name;
}

/**
 * Les treize lignes, dans l'ordre de la planche. La ligne Password n'existe
 * qu'en `local-auth` : dans les deux autres modes il n'y a pas de mot de passe
 * à changer, et une ligne qui ouvrirait un formulaire sans objet est pire que
 * pas de ligne.
 */
export function buildSettingRows(src: SettingsSource): SettingRow[] {
  const rows: SettingRow[] = [];

  // ── Access ────────────────────────────────────────────────────────────────
  rows.push({
    id: 'sign-in',
    group: 'access',
    name: 'Sign-in',
    lede: 'Choose how users sign in to this workspace.',
    value: signInValue(src),
    tag: AUTH_MODE_TAG[src.authMode],
  });

  rows.push({
    id: 'network',
    group: 'access',
    name: 'Network access',
    lede: 'Control which devices can reach the dashboard.',
    value: networkValue(src.network),
    tag:
      src.network === null
        ? { variant: 'warn', label: 'UNREAD' }
        : src.network.configuredBind === 'lan'
          ? { variant: 'warn', label: 'LAN' }
          : { variant: 'ok', label: 'LOCAL' },
  });

  if (src.authMode === 'local-auth') {
    rows.push({
      id: 'password',
      group: 'access',
      name: 'Password',
      lede: 'Change your sign-in password. Other signed-in devices are signed out.',
      // Un mot de passe n'a pas de valeur à montrer, et le produit ne garde
      // pas la date du dernier changement. La ligne dit donc ce qu'elle fait.
      value: 'Change it here',
    });
  }

  rows.push({
    id: 'worker-secret',
    group: 'access',
    name: 'Worker secret',
    lede: 'The shared secret the web app uses to call the runner. Set by the installer.',
    value: src.workerSecretConfigured ? 'Set at install' : 'Missing, runner calls will 403',
    tag: src.workerSecretConfigured
      ? { variant: 'ok', label: 'CONFIGURED' }
      : { variant: 'warn', label: 'MISSING' },
  });

  // ── Safety ────────────────────────────────────────────────────────────────
  rows.push({
    id: 'auto-run-brake',
    group: 'safety',
    name: 'Auto-run brake',
    lede: 'The workspace-wide emergency brake. Pause every auto-run at once, release to re-arm.',
    value:
      src.autoRunPause === null ? UNREAD : src.autoRunPause.autoRunPaused ? 'Paused' : 'Released',
    toggle: src.autoRunPause?.autoRunPaused ?? false,
  });

  rows.push({
    id: 'verification',
    group: 'safety',
    name: 'Verification surfaces',
    lede: "Which ways of working get proven by a project's proof commands.",
    value: verificationValue(src.verification),
    tag:
      src.verification === null
        ? { variant: 'warn', label: 'UNREAD' }
        : (() => {
            const on = VERIFICATION_SURFACE_KEYS.filter(
              (k) => src.verification!.surfaces[k],
            ).length;
            const total = VERIFICATION_SURFACE_KEYS.length;
            return {
              variant: on === total ? ('ok' as const) : ('warn' as const),
              label: `${on} OF ${total}`,
            };
          })(),
  });

  rows.push({
    id: 'repair-turns',
    group: 'safety',
    name: 'Repair turns',
    lede: 'How many times a run gets to fix itself when its proof fails, and what else bounds a run.',
    value:
      src.proofRepair === null
        ? UNREAD
        : src.proofRepair.repairAttempts === 0
          ? 'None, a failed proof ends the run'
          : src.proofRepair.repairAttempts === 1
            ? 'One repair turn'
            : `Up to ${src.proofRepair.repairAttempts} repair turns`,
    tag:
      src.proofRepair === null
        ? { variant: 'warn', label: 'UNREAD' }
        : { variant: 'ok', label: `${src.proofRepair.repairAttempts} MAX` },
  });

  rows.push({
    id: 'run-budget',
    group: 'safety',
    name: 'Run budget',
    lede: 'What one run may cost and how long it may work. A run that reaches it stops and keeps what it wrote.',
    value:
      src.runBudget === null
        ? UNREAD
        : runBudgetValue(src.runBudget.maxRunCostUsd, src.runBudget.maxRunHours),
    ...(src.runBudget === null ? { tag: { variant: 'warn' as const, label: 'UNREAD' } } : {}),
  });

  rows.push({
    id: 'root-agent',
    group: 'safety',
    name: 'ROOT agent',
    lede: 'Your first orchestrator runs this workspace on your behalf. Tune its powers here.',
    value: rootAgentValue(src),
  });

  rows.push({
    id: 'mcp-server',
    group: 'safety',
    name: 'MCP server',
    lede: "External clients can hand work to the root agent through Nodal's MCP server.",
    value:
      src.mcpServer === null
        ? UNREAD
        : src.mcpServer.enabled
          ? 'External clients reach the root agent'
          : 'Closed to external clients',
    toggle: src.mcpServer?.enabled ?? false,
  });

  // ── Workspace ─────────────────────────────────────────────────────────────
  rows.push({
    id: 'timezone',
    group: 'workspace',
    name: 'Timezone',
    lede: 'The zone your agents use to tell the time and schedule automations.',
    value:
      src.timezone === null
        ? UNREAD
        : src.timezone.isExplicit
          ? src.timezone.timezone
          : `${src.timezone.timezone}, detected`,
  });

  rows.push({
    id: 'install-notes',
    group: 'workspace',
    name: 'Install notes',
    lede: "Machine-specific context injected into every agent's runtime block.",
    value: installNotesValue(src.installNotes),
    tag:
      src.installNotes === null
        ? { variant: 'warn', label: 'UNREAD' }
        : src.installNotes.trim() === ''
          ? { variant: 'warn', label: 'EMPTY' }
          : { variant: 'ok', label: 'SET' },
  });

  rows.push({
    id: 'workspaces',
    group: 'workspace',
    name: 'Workspaces',
    lede: 'Each workspace scopes its own agents, credentials and data.',
    value: workspacesValue(src.workspaces),
    tag: src.workspaces.some((w) => w.active)
      ? { variant: 'ok', label: 'ACTIVE' }
      : { variant: 'warn', label: 'NONE' },
  });

  // ── Advanced, read only ───────────────────────────────────────────────────
  rows.push({
    id: 'urls',
    group: 'advanced',
    name: 'URLs',
    lede: 'Where this install answers, and where its shared folder is. Read only.',
    value: 'App, runner, webhooks, shared folder',
  });

  rows.push({
    id: 'session',
    group: 'advanced',
    name: 'Session',
    lede: 'The identifiers of your account and this workspace in the local DB. Read only.',
    value: 'User and workspace identifiers',
  });

  return rows;
}

/** Les lignes dont le NOM contient le filtre. Vide ⇒ toutes. */
export function filterSettingRows(rows: SettingRow[], query: string): SettingRow[] {
  const q = query.trim().toLowerCase();
  if (q === '') return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(q));
}
