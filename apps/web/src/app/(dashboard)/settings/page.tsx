import Link from 'next/link';
import {
  getSettingsAction,
  getSecuritySettingsAction,
  getNetworkSettingsAction,
  listWorkspacesAction,
  getRootConfigAction,
  listAgentsAction,
  getLanCommandYoloAction,
  getMcpServerSwitchAction,
  getInstallNotesAction,
  getWorkspaceTimezoneAction,
  type WorkspaceRow,
} from '@/lib/actions.ts';
import { DEFAULT_ROOT_GRANTS } from '@nodal-agents/shared';
import SecurityForm from './SecurityForm.tsx';
import NetworkForm from './NetworkForm.tsx';
import WorkspacesSection from './WorkspacesSection.tsx';
import RootAgentSection from './RootAgentSection.tsx';
import LanCommandYoloSection from './LanCommandYoloSection.tsx';
import McpServerSection from './McpServerSection.tsx';
import InstallNotesForm from './InstallNotesForm.tsx';
import TimezoneForm from './TimezoneForm.tsx';
import PageShell from '@/components/ui/PageShell';
import { SetBlock } from '@/components/ui/SetBlock.tsx';
import { SetPane } from '@/components/ui/SetPane.tsx';
import { SetRow } from '@/components/ui/SetRow.tsx';
import MonoCode from '@/components/ui/MonoCode';
import CopyablePath from '@/components/ui/CopyablePath';
import { TagMini } from '@/components/ui/TagMini.tsx';
import { CheckOk } from '@/components/ui/CheckOk.tsx';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const [
    result,
    securityResult,
    networkResult,
    wsResult,
    rootConfigResult,
    agentsResult,
    lanYoloResult,
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
    getLanCommandYoloAction(),
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

  return (
    <PageShell title="Settings" subtitle="Security mode and network access for this workspace.">
      <div>
        <SetBlock label="Auth">
          <SetPane>
            <SetRow label="Mode">
              <MonoCode>{s.authMode}</MonoCode>
              <AuthTagMini mode={s.authMode} />
            </SetRow>
            <SetRow label="Worker secret">
              {s.workerSecretConfigured ? (
                <CheckOk>configured</CheckOk>
              ) : (
                <span className="text-medium-14 text-warn">missing — runner calls will 403</span>
              )}
            </SetRow>
          </SetPane>
        </SetBlock>

        {securityResult.ok && (
          <SetBlock label="Security" lede="Choose how users sign in to this workspace.">
            <SecurityForm initial={securityResult.data} />
          </SetBlock>
        )}

        {networkResult.ok && (
          <SetBlock label="Network" lede="Control which devices can reach the dashboard.">
            <NetworkForm initial={networkResult.data} />
          </SetBlock>
        )}

        {tzResult.ok && (
          <SetBlock
            label="Timezone"
            lede="The zone your agents use to tell the time and schedule automations."
          >
            <TimezoneForm initial={tzResult.data.timezone} isExplicit={tzResult.data.isExplicit} />
          </SetBlock>
        )}

        {lanYoloResult.ok && s.authMode !== 'local-trust' && (
          <SetBlock
            label="Command execution (LAN)"
            lede="On a network install, shell commands and coding CLI tasks always require approval by default. This switch does not change that — it only lets the owner unlock Yolo (auto-run) agent by agent."
          >
            <LanCommandYoloSection initial={lanYoloResult.data} />
          </SetBlock>
        )}

        {mcpSwitchResult.ok && (
          <SetBlock
            label="MCP server"
            lede="External clients (your terminal, a coding agent) can hand work to the root agent through Nodal's MCP server. Off by default; MCP jobs never get the configuration tools."
          >
            <McpServerSection initial={mcpSwitchResult.data} />
          </SetBlock>
        )}

        {installNotesResult.ok && (
          <SetBlock
            label="Install notes"
            lede="Machine-specific context injected into every agent's runtime block. Apply live — no restart needed."
          >
            <InstallNotesForm initial={installNotesResult.data} />
          </SetBlock>
        )}

        <RootAgentSection
          agents={agentsResult.ok ? agentsResult.data : []}
          initialRootAgentId={rootConfigResult.ok ? rootConfigResult.data.rootAgentId : null}
          initialGrants={rootConfigResult.ok ? rootConfigResult.data.grants : DEFAULT_ROOT_GRANTS}
        />

        <WorkspacesSection initial={workspaces} />

        <SetBlock label="URLs">
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
                className="text-xs text-ink-3 hover:text-ink-2 transition-colors"
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
        </SetBlock>

        <SetBlock label="Session">
          <SetPane>
            <SetRow label="User ID" sub="Your account identifier in the local DB.">
              <MonoCode>{s.user.userId}</MonoCode>
            </SetRow>
            <SetRow label="Workspace ID" sub="Entity identifier scoped to this install.">
              <MonoCode>{s.user.entityId}</MonoCode>
            </SetRow>
          </SetPane>
        </SetBlock>
      </div>
    </PageShell>
  );
}

function AuthTagMini({ mode }: { mode: 'local-trust' | 'local-auth' | 'bearer-token' }) {
  if (mode === 'local-auth') return <TagMini variant="ok">PASSWORD</TagMini>;
  if (mode === 'bearer-token') return <TagMini variant="ok">TOKEN</TagMini>;
  return <TagMini variant="warn">NO AUTH</TagMini>;
}
