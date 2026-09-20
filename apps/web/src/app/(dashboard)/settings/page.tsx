/**
 * /settings — UNE page par famille de réglages (`?page=access|safety|workspace|
 * install`, Quentin 20/09), les formulaires EN PLACE dans la page.
 *
 * Le panneau ancré de #231 est parti : il fallait ouvrir chaque réglage un par
 * un. La page ne fait toujours que deux choses : lire, et distribuer. Elle lit
 * les treize valeurs (`buildSettingRows`, testé à part), et elle donne à la
 * page demandée les formulaires EXISTANTS, inchangés — ce sont eux qui
 * enregistrent, chacun avec son action serveur et ses propres Cancel / Save
 * (`SetCtaRow`, hors de tout pied ancré).
 */

import Link from 'next/link';
import {
  getSettingsAction,
  getSecuritySettingsAction,
  getNetworkSettingsAction,
  listWorkspacesAction,
  getRootConfigAction,
  listAgentsAction,
  getAutoRunPauseAction,
  getVerificationSurfacesAction,
  getMcpServerSwitchAction,
  getInstallNotesAction,
  getWorkspaceTimezoneAction,
  type WorkspaceRow,
} from '@/lib/actions.ts';
import { DEFAULT_ROOT_GRANTS } from '@nodal-agents/shared';
import SecurityForm from './SecurityForm.tsx';
import PasswordForm from './PasswordForm.tsx';
import NetworkForm from './NetworkForm.tsx';
import WorkspacesSection from './WorkspacesSection.tsx';
import RootAgentSection from './RootAgentSection.tsx';
import AutoRunPauseSection from './AutoRunPauseSection.tsx';
import VerificationSurfacesSection from './VerificationSurfacesSection.tsx';
import McpServerSection from './McpServerSection.tsx';
import InstallNotesForm from './InstallNotesForm.tsx';
import TimezoneForm from './TimezoneForm.tsx';
import SettingsSections from './SettingsSections.tsx';
import { resolveSettingsPage } from './settings-pages.ts';
import { buildSettingRows, type SettingId } from './settings-rows.ts';
import PageShell from '@/components/ui/PageShell';
import { SetPane } from '@/components/ui/SetPane.tsx';
import { SetRow } from '@/components/ui/SetRow.tsx';
import MonoCode from '@/components/ui/MonoCode';
import CopyablePath from '@/components/ui/CopyablePath';

export const dynamic = 'force-dynamic';

const SETTING_IDS: ReadonlySet<string> = new Set<SettingId>([
  'sign-in',
  'network',
  'password',
  'worker-secret',
  'auto-run-brake',
  'verification',
  'root-agent',
  'mcp-server',
  'timezone',
  'install-notes',
  'workspaces',
  'urls',
  'session',
]);

type PageProps = {
  /** `?page=` choisit la page ; `?open=<réglage>` (liens d'avant le 20/09) y mène aussi. */
  searchParams: Promise<{ page?: string; open?: string }>;
};

export default async function SettingsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const [
    result,
    securityResult,
    networkResult,
    wsResult,
    rootConfigResult,
    agentsResult,
    autoRunPauseResult,
    verificationSurfacesResult,
    mcpSwitchResult,
    installNotesResult,
    tzResult,
  ] = await Promise.all([
    getSettingsAction(),
    getSecuritySettingsAction(),
    getNetworkSettingsAction(),
    listWorkspacesAction(),
    getRootConfigAction(),
    listAgentsAction(),
    getAutoRunPauseAction(),
    getVerificationSurfacesAction(),
    getMcpServerSwitchAction(),
    getInstallNotesAction(),
    getWorkspaceTimezoneAction(),
  ]);
  const workspaces: WorkspaceRow[] = wsResult.ok ? wsResult.data : [];

  if (!result.ok) {
    return (
      <PageShell title="Settings">
        <div className="rounded-2xl border border-warn/40 bg-warn-bg p-5 text-sm text-warn">
          {result.message}
        </div>
      </PageShell>
    );
  }

  const s = result.data;
  const grants = rootConfigResult.ok ? rootConfigResult.data.grants : DEFAULT_ROOT_GRANTS;

  const rows = buildSettingRows({
    authMode: s.authMode,
    workerSecretConfigured: s.workerSecretConfigured,
    security: securityResult.ok ? securityResult.data : null,
    network: networkResult.ok ? networkResult.data : null,
    autoRunPause: autoRunPauseResult.ok ? autoRunPauseResult.data : null,
    verification: verificationSurfacesResult.ok ? verificationSurfacesResult.data : null,
    mcpServer: mcpSwitchResult.ok ? mcpSwitchResult.data : null,
    timezone: tzResult.ok ? tzResult.data : null,
    installNotes: installNotesResult.ok ? installNotesResult.data : null,
    workspaces,
    agents: agentsResult.ok ? agentsResult.data : [],
    rootAgentId: rootConfigResult.ok ? rootConfigResult.data.rootAgentId : null,
    rootAutonomy: grants.autonomy,
  });

  // Les formulaires existants, tels quels : le panneau porte le titre et le
  // lede, eux gardent leur contenu, leur validation et leur action serveur.
  const panels: Partial<Record<SettingId, React.ReactNode>> = {
    'sign-in': securityResult.ok ? <SecurityForm initial={securityResult.data} /> : null,
    network: networkResult.ok ? <NetworkForm initial={networkResult.data} /> : null,
    password: s.authMode === 'local-auth' ? <PasswordForm /> : null,
    'worker-secret': <WorkerSecretPanel configured={s.workerSecretConfigured} />,
    'auto-run-brake': autoRunPauseResult.ok ? (
      <AutoRunPauseSection initial={autoRunPauseResult.data} />
    ) : null,
    verification: verificationSurfacesResult.ok ? (
      <VerificationSurfacesSection initial={verificationSurfacesResult.data} />
    ) : null,
    'root-agent': (
      <RootAgentSection
        agents={agentsResult.ok ? agentsResult.data : []}
        initialRootAgentId={rootConfigResult.ok ? rootConfigResult.data.rootAgentId : null}
        initialGrants={grants}
      />
    ),
    'mcp-server': mcpSwitchResult.ok ? <McpServerSection initial={mcpSwitchResult.data} /> : null,
    timezone: tzResult.ok ? (
      <TimezoneForm initial={tzResult.data.timezone} isExplicit={tzResult.data.isExplicit} />
    ) : null,
    'install-notes': installNotesResult.ok ? (
      <InstallNotesForm initial={installNotesResult.data} />
    ) : null,
    workspaces: <WorkspacesSection initial={workspaces} />,
    urls: (
      <SetPane>
        <SetRow label="App URL">
          <MonoCode>{s.appUrl}</MonoCode>
        </SetRow>
        <SetRow label="Runner URL">
          <MonoCode>{s.runnerUrl}</MonoCode>
        </SetRow>
        <SetRow label="Webhooks" sub="Each automation trigger has its own webhook URL.">
          <Link
            href="/automations"
            className="text-xs text-ink-3 transition-colors hover:text-ink-2"
          >
            Manage webhooks in Automations
          </Link>
        </SetRow>
        <SetRow
          label="Shared workspace"
          sub="The folder your agents read and write together. Open it to grab generated files."
        >
          <CopyablePath
            display={s.sharedWorkspacePathShort}
            value={s.sharedWorkspacePath}
            href={s.sharedWorkspaceUrl}
          />
        </SetRow>
      </SetPane>
    ),
    session: (
      <SetPane>
        <SetRow label="User ID" sub="Your account identifier in the local DB.">
          <MonoCode>{s.user.userId}</MonoCode>
        </SetRow>
        <SetRow label="Workspace ID" sub="Entity identifier scoped to this install.">
          <MonoCode>{s.user.entityId}</MonoCode>
        </SetRow>
      </SetPane>
    ),
  };

  // UNE page par entrée du menu (20/09) : ses réglages, dans l'ordre de la
  // planche, chacun avec son formulaire en place. Une valeur d'URL inconnue
  // ouvre Access, et ne casse rien.
  const page = resolveSettingsPage(sp);
  const ids = new Set<string>(page.ids);
  const pageRows = rows.filter((r) => SETTING_IDS.has(r.id) && ids.has(r.id));

  return (
    <PageShell title={page.label} subtitle={page.lede}>
      <SettingsSections rows={pageRows} panels={panels} />
    </PageShell>
  );
}

/**
 * Le secret du worker n'a pas de formulaire : il est posé par l'installeur et
 * ne se change pas depuis le dashboard. Le panneau dit donc ce qu'il est et où
 * il vit, plutôt que d'ouvrir un champ qui ne mènerait nulle part.
 */
function WorkerSecretPanel({ configured }: { configured: boolean }) {
  return (
    <SetPane>
      <SetRow label="Status">
        {configured ? (
          <span className="text-medium-14 text-ink-2">Set at install</span>
        ) : (
          <span className="text-medium-14 text-warn">Missing, runner calls will 403</span>
        )}
      </SetRow>
      <SetRow
        label="Where it lives"
        sub="Set by the installer in the environment of the web app and the runner. Restart the stack after changing it."
      >
        <MonoCode>WORKER_SECRET</MonoCode>
      </SetRow>
    </SetPane>
  );
}
