import type { ConnectionState } from '@nodal-agents/shared';
import StatusPill from '@/components/ui/StatusPill';
import { connectionLabel, connectionReason, connectionVariant } from '@/lib/connection-status.ts';

interface Props {
  connection: ConnectionState;
  /** Show the reason under the pill (edit panels); tables keep it as the tooltip. */
  withReason?: boolean;
  className?: string;
}

/**
 * The status of a connection (a connector, a credential, an MCP server, a
 * channel), from the state the engine keeps. The pill and its reason are the
 * same words on every screen.
 */
export default function ConnectionStatusPill({ connection, withReason = false, className }: Props) {
  const reason = connectionReason(connection);
  return (
    <span
      className={`inline-flex flex-col items-end gap-1 ${className ?? ''}`}
      title={reason ?? undefined}
    >
      <StatusPill variant={connectionVariant(connection)} label={connectionLabel(connection)} />
      {withReason && reason && (
        <span className="max-w-xs text-right text-label-11 text-ink-3">{reason}</span>
      )}
    </span>
  );
}
