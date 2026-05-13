import {
  getSettingsAction,
  getSecuritySettingsAction,
  getNetworkSettingsAction,
  listLlmKeysAction,
} from '@/lib/actions.ts';
import SecurityForm from './SecurityForm.tsx';
import NetworkForm from './NetworkForm.tsx';
import LlmKeysList from './LlmKeysList.tsx';

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
      <div className="space-y-6 max-w-3xl">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <div className="bg-neutral-900 border border-red-900/40 rounded-xl px-6 py-8 text-sm text-red-300">
          {result.message}
        </div>
      </div>
    );
  }

  const s = result.data;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-sm text-neutral-500 mt-0.5">
          LLM providers, security mode, and network access are editable here. Session and worker
          secret are seeded by <code className="font-mono text-neutral-400">nodal-agents init</code> and
          surfaced read-only.
        </p>
      </div>

      <div>
        <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
          LLM providers
        </h2>
        <p className="text-xs text-neutral-500 mb-3">
          Configure providers your agents can use. Each agent picks one provider and types its own
          model on top.
        </p>
        {llmKeysResult.ok ? (
          <LlmKeysList initialRows={llmKeysResult.data} />
        ) : (
          <div className="bg-neutral-900 border border-red-900/40 rounded-xl px-6 py-4 text-sm text-red-300">
            {llmKeysResult.message}
          </div>
        )}
      </div>

      <Section title="Auth">
        <Field
          label="Mode"
          value={
            <span className="flex items-center gap-2">
              <code className="font-mono">{s.authMode}</code>
              <AuthBadge mode={s.authMode} />
            </span>
          }
        />
        <Field
          label="Worker secret"
          value={
            s.workerSecretConfigured ? (
              <span className="text-emerald-400">configured</span>
            ) : (
              <Missing>missing — runner calls will 403</Missing>
            )
          }
        />
      </Section>

      {securityResult.ok && (
        <div>
          <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
            Security
          </h2>
          <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-5 py-5">
            <SecurityForm initial={securityResult.data} />
          </div>
        </div>
      )}

      {networkResult.ok && (
        <div>
          <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
            Network
          </h2>
          <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-5 py-5">
            <NetworkForm initial={networkResult.data} />
          </div>
          <div className="mt-3 bg-neutral-900 border border-neutral-800/60 rounded-xl divide-y divide-neutral-800/60">
            <Field label="App URL" value={s.appUrl} mono />
            <Field label="Runner URL" value={s.runnerUrl} mono />
          </div>
        </div>
      )}

      <Section title="Session">
        <Field label="User ID" value={s.user.userId} mono />
        <Field label="Workspace ID" value={s.user.entityId} mono />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
        {title}
      </h2>
      <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl divide-y divide-neutral-800/60">
        {children}
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <span className="text-sm text-neutral-400 shrink-0">{label}</span>
      <span
        className={`text-sm text-white text-right break-all ${mono ? 'font-mono text-xs' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}

function Missing({ children }: { children: React.ReactNode }) {
  return <span className="text-amber-400">{children}</span>;
}

function AuthBadge({ mode }: { mode: 'local-trust' | 'local-auth' | 'bearer-token' }) {
  const map = {
    'local-trust': { label: 'no auth', cls: 'bg-amber-500/15 text-amber-400' },
    'local-auth': { label: 'password', cls: 'bg-emerald-500/15 text-emerald-400' },
    'bearer-token': { label: 'token', cls: 'bg-blue-500/15 text-blue-400' },
  } as const;
  const m = map[mode];
  return (
    <span
      className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${m.cls}`}
    >
      {m.label}
    </span>
  );
}
