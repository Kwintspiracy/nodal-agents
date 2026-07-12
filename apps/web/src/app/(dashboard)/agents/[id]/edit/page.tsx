import { redirect } from 'next/navigation';
import {
  getAgentForEditAction,
  listAgentsAction,
  listLlmKeysAction,
  listAgentConnectorsAction,
  listAgentMcpServersAction,
  listJobsAction,
  getAgentAttachedSkillsAction,
  listSkillsAction,
  getLanCommandYoloAction,
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

  // Per-agent data — fetched after the agent is confirmed to exist.
  const [
    connectorsResult,
    mcpServersResult,
    jobsResult,
    skillsResult,
    allSkillsResult,
    lanYoloResult,
  ] = await Promise.all([
    listAgentConnectorsAction(agent.id),
    listAgentMcpServersAction(agent.id),
    listJobsAction({ limit: 100 }),
    getAgentAttachedSkillsAction(agent.id),
    // Entity-wide skill catalog — powers the "attach from available" list in
    // the Skills tab (parity with how Connectors already lists everything
    // installed on the workspace, not just what's assigned to this agent).
    listSkillsAction(),
    getLanCommandYoloAction(),
  ]);
  const connectors = connectorsResult.ok ? connectorsResult.data : [];
  const mcpServers = mcpServersResult.ok ? mcpServersResult.data : [];
  // Filter jobs to this agent client-side — `listJobsAction` is global at the
  // server action layer; the table-level filter keeps that surface unchanged.
  const jobs = (jobsResult.ok ? jobsResult.data : []).filter((j) => j.agentId === agent.id);
  // Skills attached to this agent — with per-assignment scriptsAuthorized populated.
  const attachedSkills = skillsResult.ok ? skillsResult.data : [];
  const allSkills = allSkillsResult.ok ? allSkillsResult.data : [];

  const lanCommandYolo = lanYoloResult.ok ? lanYoloResult.data.lanCommandYolo : false;
  const isOwner = lanYoloResult.ok ? lanYoloResult.data.isOwner : false;

  return (
    <AgentComposer
      agent={agent}
      peers={peers}
      allAgents={peersResult.ok ? peersResult.data : []}
      llmKeys={llmKeys}
      connectors={connectors}
      mcpServers={mcpServers}
      jobs={jobs}
      attachedSkills={attachedSkills}
      allSkills={allSkills}
      lanCommandYolo={lanCommandYolo}
      isOwner={isOwner}
    />
  );
}
