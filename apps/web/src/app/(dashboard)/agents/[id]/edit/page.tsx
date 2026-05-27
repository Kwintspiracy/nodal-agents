import { redirect } from 'next/navigation';
import {
  getAgentForEditAction,
  listAgentsAction,
  listLlmKeysAction,
  listAgentConnectorsAction,
  listAgentMcpServersAction,
} from '@/lib/actions.ts';
import AgentComposer from './AgentComposer.tsx';

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
    <AgentComposer
      agent={agent}
      peers={peers}
      llmKeys={llmKeys}
      connectors={connectors}
      mcpServers={mcpServers}
    />
  );
}
