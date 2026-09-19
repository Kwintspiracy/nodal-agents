/**
 * /settings — UNE liste de réglages, chacun s'ouvrant dans un panneau ancré à
 * droite (planches S3 + P1, issue #231).
 *
 * Avant : onze blocs empilés en une colonne, sans ordre entre ce qui touche à
 * l'accès, à la sûreté, et ce qui n'est là que pour être lu. La page ne fait
 * plus que deux choses : lire, et distribuer. Elle lit les treize valeurs
 * (`buildSettingRows`, testé à part), et elle passe à la liste les formulaires
 * EXISTANTS, inchangés — ce sont eux qui enregistrent, chacun avec son action
 * serveur, exactement comme avant.
 *
 * Chacun reçoit en plus un `formId`, et rien d'autre : c'est par lui que le
 * bouton Save posé au bas du panneau soumet le bon formulaire (attribut HTML
 * `form`, voir `DockedFormCta.tsx`). Les sections à interrupteur immédiat n'en
 * reçoivent pas — elles n'ont rien à soumettre.
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
import SettingsList from './SettingsList.tsx';
import { buildSettingRows, type SettingId } from './settings-rows.ts';
import { dockedFormId } from '@/components/ui/DockedFormCta.tsx';
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
  searchParams: Promise<{ open?: string }>;
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
    'sign-in': securityResult.ok ? (
      <SecurityForm initial={securityResult.data} formId={dockedFormId('sign-in')} />
    ) : null,
    network: networkResult.ok ? (
      <NetworkForm initial={networkResult.data} formId={dockedFormId('network')} />
    ) : null,
    password:
      s.authMode === 'local-auth' ? <PasswordForm formId={dockedFormId('password')} /> : null,
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
        formId={dockedFormId('root-agent')}
      />
    ),
    'mcp-server': mcpSwitchResult.ok ? <McpServerSection initial={mcpSwitchResult.data} /> : null,
    timezone: tzResult.ok ? (
      <TimezoneForm
        initial={tzResult.data.timezone}
        isExplicit={tzResult.data.isExplicit}
        formId={dockedFormId('timezone')}
      />
    ) : null,
    'install-notes': installNotesResult.ok ? (
      <InstallNotesForm initial={installNotesResult.data} formId={dockedFormId('install-notes')} />
    ) : null,
    workspaces: <WorkspacesSection initial={workspaces} formId={dockedFormId('workspaces')} />,
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

  // Une valeur d'URL inconnue n'ouvre rien, et ne casse rien.
  const wanted = sp.open;
  const initialOpen =
    wanted !== undefined && SETTING_IDS.has(wanted) && rows.some((r) => r.id === wanted)
      ? (wanted as SettingId)
      : null;

  return (
    <PageShell
      title="Settings"
      subtitle="One list. Each row shows its current value and opens on the right."
      fill
    >
      <SettingsList rows={rows} panels={panels} initialOpen={initialOpen} />
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
          <span className="text-medium-14 text-warn">missing — runner calls will 403</span>
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
