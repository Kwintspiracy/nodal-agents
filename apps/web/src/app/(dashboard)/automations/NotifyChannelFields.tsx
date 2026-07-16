'use client';

import { useEffect, useState } from 'react';
import { listAgentNotifyChannelsAction } from '@/lib/actions.ts';
import Select from '@/components/ui/Select';
import Checkbox from '@/components/ui/Checkbox';

export const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
};

interface Props {
  /** Prefixes the field id (e.g. "schedule" / "webhook") so ScheduleForm and
   *  WebhookForm can both mount on /automations without colliding DOM ids. */
  idPrefix: string;
  agentId: string;
  /** Name of the currently selected agent, for the "no channel" warning —
   *  undefined while no agent is picked yet. */
  agentName: string | undefined;
  notifyOnSuccess: boolean;
  onNotifyOnSuccessChange: (value: boolean) => void;
  /** '' = Auto (null on the wire) — native <select> values are always strings. */
  notifyChannel: string;
  onNotifyChannelChange: (value: string) => void;
}

/**
 * "Notify me when it succeeds" toggle + "Notify via" channel select, shared by
 * ScheduleForm and WebhookForm (B1/B2, notify-channel-choice plan) — same
 * mechanic, same copy, on any automation trigger that ends with an owner
 * confirmation. Owns the listAgentNotifyChannelsAction fetch itself (reloaded
 * whenever `agentId` changes) so both callers only hold the two form values.
 */
export default function NotifyChannelFields({
  idPrefix,
  agentId,
  agentName,
  notifyOnSuccess,
  onNotifyOnSuccessChange,
  notifyChannel,
  onNotifyChannelChange,
}: Props) {
  // Reloaded whenever the selected agent changes — the channels a trigger can
  // notify on are exactly the ones this agent is actually bound to. Keyed by
  // the agentId the response is FOR (not just the raw list) so "loading" and
  // "no agent yet" can be DERIVED at render time instead of reset via a
  // synchronous setState in the effect body (react-hooks/set-state-in-effect
  // — see WhatsAppConfigForm.tsx for the same idiom: only setState inside a
  // `.then()`, never at the top of the effect).
  const [channelsFetch, setChannelsFetch] = useState<{
    agentId: string;
    options: string[];
  } | null>(null);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    listAgentNotifyChannelsAction(agentId).then((r) => {
      if (cancelled) return;
      setChannelsFetch({ agentId, options: r.ok ? r.data : [] });
    });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const loadingChannels = agentId !== '' && channelsFetch?.agentId !== agentId;
  const effectiveChannelOptions = channelsFetch?.agentId === agentId ? channelsFetch.options : [];

  // Notify delivery is per-agent (the runner sends via the executing agent's own
  // channel binding). A "notify" trigger on an agent with NO connected channel
  // can never reach the user — warn instead of letting it silently no-op.
  // Whether a specific chosen channel has an owner conversation yet is NOT
  // checked here — that's verified at fire time (fail loud), not guessed at
  // form time.
  const lacksChannel =
    notifyOnSuccess && agentId !== '' && !loadingChannels && effectiveChannelOptions.length === 0;

  return (
    <div className="space-y-2">
      <label className="flex items-start gap-2.5 rounded-md border border-rule bg-canvas px-3 py-2.5 text-sm">
        <Checkbox
          name="notifyOnSuccess"
          checked={notifyOnSuccess}
          onChange={(e) => onNotifyOnSuccessChange(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium text-ink">Notify me when it succeeds</span>
          <span className="mt-0.5 block text-xs text-ink-3">
            The agent sends you a short confirmation each time this automation finishes. Requires a
            connected channel on the agent (message it once so it knows where to reach you).
          </span>
        </span>
      </label>

      {notifyOnSuccess &&
        (lacksChannel ? (
          <p className="rounded-md border border-warn/30 bg-warn-bg px-3 py-2 text-xs text-warn">
            ⚠️ <span className="font-medium">{agentName}</span>
            {` has no channel connected, so it can't send you this confirmation. Connect Telegram, Discord, or Slack to this agent first.`}
          </p>
        ) : (
          <Select
            id={`${idPrefix}-notify-channel`}
            label="Notify via"
            value={notifyChannel}
            onChange={(e) => onNotifyChannelChange(e.target.value)}
            disabled={loadingChannels}
          >
            <option value="">Auto</option>
            {effectiveChannelOptions.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c] ?? c}
              </option>
            ))}
          </Select>
        ))}
    </div>
  );
}
