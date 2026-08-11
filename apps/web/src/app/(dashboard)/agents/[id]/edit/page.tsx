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
  getAgentChannelsAction,
  getAgentTelegramConfigAction,
  getTelegramAllowedChatsAction,
  getAgentDiscordConfigAction,
  getAgentSlackConfigAction,
  getChannelAllowedConversationsAction,
  listVoiceOptionsAction,
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

  // Resolved on the SERVER and passed down: the voice catalogue belongs to
  // packages/speech, and re-typing it in a picker would be exactly the
  // hardcoded metadata invariant #1 forbids — plus the provider module pulls in
  // Node APIs that have no business in a browser bundle. Every provider with a
  // key, not just Google: the form used to write 'google' as a literal, which
  // left the streaming provider selectable nowhere.
  const voicesResult = await listVoiceOptionsAction();
  const voiceProviders = voicesResult.ok ? voicesResult.data : [];

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
    channelsOverviewResult,
    telegramCfgResult,
    telegramAllowedChatsResult,
    discordCfgResult,
    discordAllowedConversationsResult,
    slackCfgResult,
    slackAllowedConversationsResult,
    whatsappAllowedConversationsResult,
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
    // Channels tab (in-page — see ChannelsTabContent.tsx). Same reads the old
    // standalone /agents/[id]/channels page did; that route now just
    // redirects here (?tab=channels) — one canonical surface.
    getAgentChannelsAction(agent.id),
    getAgentTelegramConfigAction(agent.id),
    getTelegramAllowedChatsAction(agent.id),
    getAgentDiscordConfigAction(agent.id),
    getChannelAllowedConversationsAction(agent.id, 'discord'),
    getAgentSlackConfigAction(agent.id),
    getChannelAllowedConversationsAction(agent.id, 'slack'),
    getChannelAllowedConversationsAction(agent.id, 'whatsapp'),
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

  // Channels tab data — the agent existing is already confirmed above, so
  // these only fail on a genuine db_error; surface the first one as a banner
  // instead of the cards rather than blowing up the whole edit page.
  const channelsError = !channelsOverviewResult.ok
    ? channelsOverviewResult.message
    : !telegramCfgResult.ok
      ? telegramCfgResult.message
      : !discordCfgResult.ok
        ? discordCfgResult.message
        : !slackCfgResult.ok
          ? slackCfgResult.message
          : null;
  // WhatsApp has no legacy columns and no per-channel config action of its
  // own — its coarse connected/disconnected status comes straight off the
  // channels overview already fetched above.
  const whatsappStatus: 'connected' | 'disconnected' =
    channelsOverviewResult.ok &&
    channelsOverviewResult.data.channels.find((c) => c.channel === 'whatsapp')?.status ===
      'connected'
      ? 'connected'
      : 'disconnected';

  return (
    <AgentComposer
      agent={agent}
      voiceProviders={voiceProviders}
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
      channelsError={channelsError}
      telegramCfg={telegramCfgResult.ok ? telegramCfgResult.data : null}
      telegramAllowedChats={telegramAllowedChatsResult.ok ? telegramAllowedChatsResult.data : []}
      discordCfg={discordCfgResult.ok ? discordCfgResult.data : null}
      discordAllowedConversations={
        discordAllowedConversationsResult.ok ? discordAllowedConversationsResult.data : []
      }
      slackCfg={slackCfgResult.ok ? slackCfgResult.data : null}
      slackAllowedConversations={
        slackAllowedConversationsResult.ok ? slackAllowedConversationsResult.data : []
      }
      whatsappStatus={whatsappStatus}
      whatsappAllowedConversations={
        whatsappAllowedConversationsResult.ok ? whatsappAllowedConversationsResult.data : []
      }
    />
  );
}
