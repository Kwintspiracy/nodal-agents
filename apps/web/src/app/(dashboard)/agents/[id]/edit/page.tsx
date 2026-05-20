import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  getAgentForEditAction,
  listAgentsAction,
  listLlmKeysAction,
  listAgentConnectorsAction,
  listAgentMcpServersAction,
} from '@/lib/actions.ts';
import AgentForm from '@/components/AgentForm.tsx';

export const dynamic = 'force-dynamic';

export default async function EditAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [agentResult, peersResult, llmKeysResult] = await Promise.all([
    getAgentForEditAction(id),
    listAgentsAction(),
    listLlmKeysAction(),
  ]);

  if (!agentResult.ok) {
    // not_found or validation_failed — bounce back to list
    redirect('/agents');
  }

  const llmKeys = llmKeysResult.ok ? llmKeysResult.data : [];
  const agent = agentResult.data;

  // Peer agents: all agents in entity excluding the one being edited
  // (an orchestrator cannot be its own sub-agent).
  const peers = peersResult.ok ? peersResult.data.filter((a) => a.id !== id) : [];

  // Connectors + MCP servers: fetch after agent is confirmed to exist.
  const [connectorsResult, mcpServersResult] = await Promise.all([
    listAgentConnectorsAction(agent.id),
    listAgentMcpServersAction(agent.id),
  ]);
  const connectors = connectorsResult.ok ? connectorsResult.data : [];
  const mcpServers = mcpServersResult.ok ? mcpServersResult.data : [];

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <Link
          href="/agents"
          className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
        >
          ← Agents
        </Link>
        <h1 className="text-2xl font-bold text-white mt-2">Edit agent</h1>
        <p className="text-sm text-neutral-500 mt-1">
          Updating personality or model invalidates the system-prompt cache for active jobs — the
          new config applies to all jobs started after saving.
        </p>
      </div>

      <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-6">
        <AgentForm
          mode="edit"
          initial={agent}
          llmKeys={llmKeys}
          agents={peers}
          connectors={connectors}
          mcpServers={mcpServers}
        />
      </div>
    </div>
  );
}
