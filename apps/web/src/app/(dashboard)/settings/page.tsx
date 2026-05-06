import { getSettingsAction, getSecuritySettingsAction } from '@/lib/actions.ts';
import SecurityForm from './SecurityForm.tsx';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const [result, securityResult] = await Promise.all([
    getSettingsAction(),
    getSecuritySettingsAction(),
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
          Read-only view. Edit via <code className="font-mono text-neutral-400">nodalai init</code>{' '}
          in the CLI, then restart with{' '}
          <code className="font-mono text-neutral-400">nodalai up</code>.
        </p>
      </div>

      <Section title="LLM Provider">
        <Field label="Provider" value={s.llm.provider ?? <Missing>not configured</Missing>} />
        <Field label="Model" value={s.llm.model ?? <Missing>not configured</Missing>} mono />
        <Field label="Endpoint" value={s.llm.baseURL ?? <Missing>not configured</Missing>} mono />
      </Section>

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

      <Section title="Network">
        <Field label="App URL" value={s.appUrl} mono />
        <Field label="Runner URL" value={s.runnerUrl} mono />
      </Section>

      <Section title="Session">
        <Field label="User ID" value={s.user.userId} mono />
        <Field label="Workspace ID" value={s.user.entityId} mono />
      </Section>

      <div className="bg-neutral-950 border border-neutral-800/40 rounded-xl px-5 py-4 text-xs text-neutral-500">
        <strong className="text-neutral-300 block mb-1">Coming soon</strong>
        Rotating LLM provider keys from the dashboard. Today this still requires{' '}
        <code className="font-mono">nodalai init</code>.
      </div>
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
