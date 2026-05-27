// Settings — Auth / Security / Network / Session. LLM providers used to live
// here but moved to /llm-providers (their own sidebar entry below /agents)
// because they're touched far more often than the rest of this page.
import {
  getSettingsAction,
  getSecuritySettingsAction,
  getNetworkSettingsAction,
} from '@/lib/actions.ts';
import SecurityForm from './SecurityForm.tsx';
import NetworkForm from './NetworkForm.tsx';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const [result, securityResult, networkResult] = await Promise.all([
    getSettingsAction(),
    getSecuritySettingsAction(),
    getNetworkSettingsAction(),
  ]);

  if (!result.ok) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-ink">Settings</h1>
        <div className="bg-paper border border-err/30 rounded-xl px-6 py-8 text-sm text-err">
          {result.message}
        </div>
      </div>
    );
  }

  const s = result.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">Settings</h1>
        <p className="text-sm text-ink-3 mt-0.5">
          Security mode and network access are editable here. Session and worker secret are seeded
          by <code className="font-mono text-ink-3">nodal-agents init</code> and surfaced read-only.
          LLM providers moved to{' '}
          <a href="/llm-providers" className="underline hover:text-ink-2">
            their own page
          </a>
          .
        </p>
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
              <span className="text-ok">configured</span>
            ) : (
              <Missing>missing — runner calls will 403</Missing>
            )
          }
        />
      </Section>

      {securityResult.ok && (
        <div>
          <h2 className="text-xs font-semibold text-ink-3 uppercase tracking-wider mb-2">
            Security
          </h2>
          <div className="bg-paper border border-rule-2 rounded-xl px-5 py-5">
            <SecurityForm initial={securityResult.data} />
          </div>
        </div>
      )}

      {networkResult.ok && (
        <div>
          <h2 className="text-xs font-semibold text-ink-3 uppercase tracking-wider mb-2">
            Network
          </h2>
          <div className="bg-paper border border-rule-2 rounded-xl px-5 py-5">
            <NetworkForm initial={networkResult.data} />
          </div>
          <div className="mt-3 bg-paper border border-rule-2 rounded-xl divide-y divide-neutral-800/60">
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
      <h2 className="text-xs font-semibold text-ink-3 uppercase tracking-wider mb-2">{title}</h2>
      <div className="bg-paper border border-rule-2 rounded-xl divide-y divide-neutral-800/60">
        {children}
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <span className="text-sm text-ink-3 shrink-0">{label}</span>
      <span className={`text-sm text-ink text-right break-all ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </span>
    </div>
  );
}

function Missing({ children }: { children: React.ReactNode }) {
  return <span className="text-warn">{children}</span>;
}

function AuthBadge({ mode }: { mode: 'local-trust' | 'local-auth' | 'bearer-token' }) {
  const map = {
    'local-trust': { label: 'no auth', cls: 'bg-warn-bg text-warn' },
    'local-auth': { label: 'password', cls: 'bg-agent-vivid/15 text-ok' },
    'bearer-token': { label: 'token', cls: 'bg-run-bg text-run' },
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
