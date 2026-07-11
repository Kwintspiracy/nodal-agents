// types.ts — delivery channel and status types

import type { ChannelKind } from './channel-adapter.ts';

// 'email' and 'log' aren't ChannelAdapter-backed (email is unconfigured today,
// log is a dev/test sink) — kept alongside the adapter-backed ChannelKinds
// rather than folded in, so this stays the single source of truth for "what
// can a delivery target" without implying every value has an adapter.
export type DeliveryChannel = ChannelKind | 'email' | 'log';

export type DeliveryStatus = 'sent' | 'skipped' | 'failed';
