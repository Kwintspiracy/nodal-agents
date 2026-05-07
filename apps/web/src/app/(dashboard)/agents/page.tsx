import Link from 'next/link';
import { listAgentsAction, deleteAgentAction } from '@/lib/actions.ts';
import AgentForm from '@/components/AgentForm.tsx';
import DeleteAgentButton from './DeleteAgentButton.tsx';
import { getConfiguredLlmProviders } from '@/lib/llm-providers.ts';
import AgentsErrorRetry from './AgentsErrorRetry.tsx';

// Force dynamic rendering — this page reads per-request DB state. Without
// this, Next.js may statically render at build time (with the placeholder
// DATABASE_URL from env.ts) and serve cached error HTML at runtime.
export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const result = await listAgentsAction();
  const models = getConfiguredLlmProviders();

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Agents</h1>
          {result.ok && (
            <p className="text-sm text-neutral-500 mt-0.5">
              {result.data.length} agent{result.data.length !== 1 ? 's' : ''}
            </p>
          )}
        </div>
        <AgentForm models={models} agents={result.ok ? result.data : []} />
      </div>

      {!result.ok ? (
        <AgentsErrorRetry message={result.message} />
      ) : result.data.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl overflow-hidden">
          <div className="px-6 py-12 text-center text-neutral-600 text-sm">
            No agents yet. Create one above.
          </div>
        </div>
      ) : (
        <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-800/60">
                <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider">
                  Name
                </th>
                <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider">
                  Slug
                </th>
                <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden md:table-cell">
                  Model
                </th>
                <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden lg:table-cell">
                  Role
                </th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {result.data.map((agent) => (
                <tr key={agent.id} className="border-b border-neutral-800/40 last:border-0">
                  <td className="px-5 py-3">
                    <span className="text-white font-medium">{agent.name}</span>
                    {agent.isDefault && (
                      <span className="ml-2 text-[10px] font-semibold text-violet-400 uppercase tracking-wider">
                        default
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 font-mono text-neutral-400 text-xs">{agent.slug}</td>
                  <td className="hidden md:table-cell px-5 py-3 text-neutral-500 text-xs">
                    {agent.model ?? '—'}
                  </td>
                  <td className="hidden lg:table-cell px-5 py-3 text-neutral-500 text-xs">
                    {agent.role ?? 'agent'}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Link
                        href={`/agents/${agent.id}/telegram`}
                        className="px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-lg hover:border-neutral-700 hover:text-white transition-colors"
                      >
                        Telegram
                      </Link>
                      <Link
                        href={`/agents/${agent.id}/edit`}
                        className="px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-lg hover:border-neutral-700 hover:text-white transition-colors"
                      >
                        Edit
                      </Link>
                      <DeleteAgentButton
                        id={agent.id}
                        name={agent.name}
                        deleteAction={deleteAgentAction}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
