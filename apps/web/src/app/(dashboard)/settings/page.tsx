import {
  getSettingsAction,
  getSecuritySettingsAction,
  getNetworkSettingsAction,
  listWorkspacesAction,
  getRootConfigAction,
  listAgentsAction,
  getLanCommandYoloAction,
  type WorkspaceRow,
} from '@/lib/actions.ts';
import { DEFAULT_ROOT_GRANTS } from '@nodal-agents/shared';
import SecurityForm from './SecurityForm.tsx';
import NetworkForm from './NetworkForm.tsx';
import WorkspacesSection from './WorkspacesSection.tsx';
import RootAgentSection from './RootAgentSection.tsx';
import LanCommandYoloSection from './LanCommandYoloSection.tsx';
import { SetBlock } from '@/components/ui/SetBlock.tsx';
import { SetPane } from '@/components/ui/SetPane.tsx';
import { SetRow } from '@/components/ui/SetRow.tsx';
import MonoCode from '@/components/ui/MonoCode';
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
  ] = await Promise.all([
    getSettingsAction(),
    getSecuritySettingsAction(),
    getNetworkSettingsAction(),
    listWorkspacesAction(),
    getRootConfigAction(),
    listAgentsAction(),
    getLanCommandYoloAction(),
  ]);
  const workspaces: WorkspaceRow[] = wsResult.ok ? wsResult.data : [];

  if (!result.ok) {
    return (
      <div className="py-7">
        <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
          Settings
        </h1>
        <div className="mt-4 rounded-2xl border border-warn/40 bg-warn-bg p-5 text-sm text-warn">
          {result.message}
        </div>
      </div>
    );
  }

  const s = result.data;

  return (
    <div className="max-w-2xl pb-10">
      <div className="mb-3.5 pt-7">
        <h1 className="m-0 text-[28px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink">
          Settings
        </h1>
        <p className="mt-2 max-w-[780px] text-[13.5px] leading-[1.6] text-ink-3">
          Security mode and network access are editable here. Session and worker secret are seeded
          by <MonoCode>nodal-agents init</MonoCode> and surfaced read-only. LLM providers live on{' '}
          <a
            href="/llm-providers"
            className="font-medium text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink-3"
          >
            their own page
          </a>
          .
        </p>
      </div>

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
              <span className="text-[13px] font-medium text-warn">
                missing — runner calls will 403
              </span>
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

      {lanYoloResult.ok && s.authMode !== 'local-trust' && (
        <SetBlock
          label="Command execution (LAN)"
          lede="In multi-user / LAN mode, shell commands always require approval by default. The workspace owner can opt in to allow Yolo (auto-run) mode per agent."
        >
          <LanCommandYoloSection initial={lanYoloResult.data} />
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
          <SetRow label="Webhook ingress">
            <MonoCode>{s.appUrl}/wh/v1</MonoCode>
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
  );
}

function AuthTagMini({ mode }: { mode: 'local-trust' | 'local-auth' | 'bearer-token' }) {
  if (mode === 'local-auth') return <TagMini variant="ok">PASSWORD</TagMini>;
  if (mode === 'bearer-token') return <TagMini variant="ok">TOKEN</TagMini>;
  return <TagMini variant="warn">NO AUTH</TagMini>;
}
