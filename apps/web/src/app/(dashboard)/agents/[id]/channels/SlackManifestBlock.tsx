'use client';

import { toast } from 'sonner';

/**
 * Ready-to-paste Slack app manifest — declares every scope/event the adapter
 * needs in one shot. This is the fix for the #1 Hermes-documented Slack
 * pitfall class: a hand-clicked app missing a scope or event, which then
 * fails silently (message received but bot can't reply, or DMs never arrive)
 * until someone notices and re-adds it one field at a time. Pasting this
 * manifest at app-creation time gets every permission right on the first try.
 */
const SLACK_APP_MANIFEST = {
  display_information: {
    name: 'Nodal Agent',
    description: 'Nodal Agent',
  },
  features: {
    bot_user: {
      display_name: 'Nodal Agent',
      always_online: true,
    },
    app_home: {
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    },
  },
  oauth_config: {
    scopes: {
      bot: [
        'chat:write',
        'im:history',
        'im:read',
        'im:write',
        'app_mentions:read',
        'channels:history',
        'groups:history',
        'files:write',
        'users:read',
      ],
    },
  },
  settings: {
    event_subscriptions: {
      bot_events: ['message.im', 'app_mention'],
    },
    interactivity: {
      is_enabled: true,
    },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};

const SLACK_APP_MANIFEST_JSON = JSON.stringify(SLACK_APP_MANIFEST, null, 2);

/** Copyable code block for the manifest above — client-only for the clipboard call. */
export default function SlackManifestBlock() {
  async function copy() {
    try {
      await navigator.clipboard.writeText(SLACK_APP_MANIFEST_JSON);
      toast.success('Manifest copied');
    } catch {
      toast.error('Could not copy');
    }
  }

  return (
    <div className="relative">
      <pre className="max-h-64 overflow-auto rounded-lg bg-canvas border border-rule-2 px-3 py-3 text-xs font-mono text-ink-2">
        {SLACK_APP_MANIFEST_JSON}
      </pre>
      <button
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 rounded-md border border-rule-2 bg-paper px-2.5 py-1 text-xs font-medium text-ink-3 hover:border-rule hover:text-ink transition-colors"
      >
        Copy
      </button>
    </div>
  );
}
