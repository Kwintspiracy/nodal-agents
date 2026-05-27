import {
  getSettingsAction,
  getSecuritySettingsAction,
  getNetworkSettingsAction,
  listLlmKeysAction,
} from '@/lib/actions.ts';
import SecurityForm from './SecurityForm.tsx';
import NetworkForm from './NetworkForm.tsx';
import LlmKeysList from './LlmKeysList.tsx';
import { SetBlock } from '@/components/ui/SetBlock.tsx';
import { SetPane } from '@/components/ui/SetPane.tsx';
import { SetRow } from '@/components/ui/SetRow.tsx';
import { MonoCode } from '@/components/ui/MonoCode.tsx';
import { TagMini } from '@/components/ui/TagMini.tsx';
import { CheckOk } from '@/components/ui/CheckOk.tsx';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const [result, securityResult, networkResult, llmKeysResult] = await Promise.all([
    getSettingsAction(),
    getSecuritySettingsAction(),
    getNetworkSettingsAction(),
    listLlmKeysAction(),
  ]);

  if (!result.ok) {
    return (
      <div className="max-w-2xl">
        <div className="set-h mb-3.5">
          <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.02em] text-white m-0">
            Settings
          </h1>
        </div>
        <div className="bg-neutral-900 border border-red-900/40 rounded-xl px-6 py-8 text-sm text-red-300">
          {result.message}
        </div>
      </div>
    );
  }

  const s = result.data;

  return (
    <div className="max-w-2xl pb-10">
      {/* ── Page header ──────────────────────────────────── */}
      <div className="mb-3.5">
        <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.02em] text-white m-0">
          Settings
        </h1>
        <p className="text-[13.5px] leading-[1.6] text-neutral-400 mt-2 max-w-[780px]">
          Security mode and network access are editable here. Session and worker secret are seeded
          by <MonoCode>nodal-agents init</MonoCode> and surfaced read-only. LLM providers moved to{' '}
          <a
            href="/llm-providers"
            className="text-neutral-300 underline underline-offset-[3px] hover:text-white"
          >
            their own page
          </a>
          .
        </p>
      </div>

      {/* ── LLM Providers ────────────────────────────────── */}
      <SetBlock
        label="LLM Providers"
        lede="Configure providers your agents can use. Each agent picks one provider and types its own model on top."
      >
        {llmKeysResult.ok ? (
          <div className="mt-3.5">
            <LlmKeysList initialRows={llmKeysResult.data} />
          </div>
        ) : (
          <div className="mt-3.5 bg-neutral-900 border border-red-900/40 rounded-xl px-6 py-4 text-sm text-red-300">
            {llmKeysResult.message}
          </div>
        )}
      </SetBlock>

      {/* ── Auth (read-only pane) ─────────────────────────── */}
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
              <span className="text-amber-400 font-medium text-[13px]">
                missing — runner calls will 403
              </span>
            )}
          </SetRow>
        </SetPane>
      </SetBlock>

      {/* ── Security (editable form) ─────────────────────── */}
      {securityResult.ok && (
        <SetBlock label="Security" lede="Choose how users sign in to this workspace.">
          <SecurityForm initial={securityResult.data} />
        </SetBlock>
      )}

      {/* ── Network (editable form) ──────────────────────── */}
      {networkResult.ok && (
        <SetBlock label="Network" lede="Control which devices can reach the dashboard.">
          <NetworkForm initial={networkResult.data} />
        </SetBlock>
      )}

      {/* ── URLs (read-only pane) ────────────────────────── */}
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

      {/* ── Session (read-only pane) ─────────────────────── */}
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
