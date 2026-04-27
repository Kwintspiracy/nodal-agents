import { listAgentsAction, deleteAgentAction } from '@/lib/actions.ts';
import AgentForm from '@/components/AgentForm.tsx';
import DeleteAgentButton from './DeleteAgentButton.tsx';

export default async function AgentsPage() {
  const result = await listAgentsAction();
  const agents = result.ok ? result.data : [];

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Agents</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            {agents.length} agent{agents.length !== 1 ? 's' : ''}
          </p>
        </div>
        <AgentForm />
      </div>

      {!result.ok && <p className="text-sm text-red-400">{result.message}</p>}

      <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl overflow-hidden">
        {agents.length === 0 ? (
          <div className="px-6 py-12 text-center text-neutral-600 text-sm">
            No agents yet. Create one above.
          </div>
        ) : (
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
              {agents.map((agent) => (
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
                    <DeleteAgentButton
                      id={agent.id}
                      name={agent.name}
                      deleteAction={deleteAgentAction}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
