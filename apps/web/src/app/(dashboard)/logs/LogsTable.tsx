'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import type { ToolCallLogRow } from '@/lib/actions.ts';
import StatusPill from '@/components/ui/StatusPill';
import type { StatusVariant } from '@/components/ui/StatusPill';

interface Props {
  items: ToolCallLogRow[];
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function isErrorOutput(output: string | null): boolean {
  if (!output) return false;
  return /^(error|\[ERROR|Error:|RuntimeError)/i.test(output.trim());
}

function prettyJson(value: unknown): string {
  // Tool output is stored as a string (sometimes JSON, sometimes plain text).
  // tool_input is stored as JSON object. Render both safely: try to parse
  // strings as JSON, fall back to the raw string.
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Map tool-call error state to the lvl-* StatusPill variant. */
function rowToLvlVariant(c: ToolCallLogRow): StatusVariant {
  if (isErrorOutput(c.toolOutput)) return 'lvl-err';
  return 'lvl-info';
}

export default function LogsTable({ items }: Props) {
  // Brique 37 — local UI state, no router round-trip. Toggling a row stays
  // within the page render, so pagination/filters are unaffected.
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);

  return (
    <div className="overflow-hidden rounded-xl border border-rule-2 bg-paper">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-rule-2">
            <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-ink-3">
              Time
            </th>
            <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-ink-3">
              Lvl
            </th>
            <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-ink-3">
              Tool
            </th>
            <th className="hidden px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-ink-3 md:table-cell">
              Agent
            </th>
            <th className="hidden px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-ink-3 lg:table-cell">
              Duration
            </th>
            <th className="hidden px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-ink-3 lg:table-cell">
              Job
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => {
            const isExpanded = expandedRowId === c.id;
            const isErr = isErrorOutput(c.toolOutput);
            return (
              <Fragment key={c.id}>
                <tr
                  className={`cursor-pointer border-b border-dashed border-rule align-top transition-colors last:border-0 ${
                    isExpanded ? 'bg-hover' : 'hover:bg-hover'
                  }`}
                  onClick={() => setExpandedRowId(isExpanded ? null : c.id)}
                  aria-expanded={isExpanded}
                  data-testid={`log-row-${c.id}`}
                >
                  <td className="px-5 py-3 font-mono text-xs text-ink-4 whitespace-nowrap">
                    {c.createdAt ? new Date(c.createdAt).toLocaleTimeString() : '—'}
                    <div className="text-[10px] text-ink-4 opacity-60">
                      {c.createdAt ? new Date(c.createdAt).toLocaleDateString() : ''}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <StatusPill variant={rowToLvlVariant(c)} icon={null} />
                  </td>
                  <td className="px-5 py-3">
                    <code className={`font-mono text-xs ${isErr ? 'text-err' : 'text-conn-vivid'}`}>
                      {c.toolName}
                    </code>
                    {c.turn !== null && (
                      <span className="ml-2 text-[10px] text-ink-4">turn {c.turn}</span>
                    )}
                  </td>
                  <td
                    className="hidden px-5 py-3 text-xs md:table-cell"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {c.agentName ? (
                      <Link href={`/logs?agent=${c.agentId}`} className="text-ink-2 hover:text-ink">
                        {c.agentName}
                      </Link>
                    ) : (
                      <span className="text-ink-4">—</span>
                    )}
                  </td>
                  <td className="hidden px-5 py-3 font-mono text-xs text-ink-3 lg:table-cell">
                    {formatDuration(c.durationMs)}
                  </td>
                  <td
                    className="hidden px-5 py-3 lg:table-cell"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {c.jobId ? (
                      <Link
                        href={`/jobs/${c.jobId}`}
                        className="font-mono text-xs text-ink-3 hover:text-ink"
                      >
                        {c.jobId.slice(0, 8)}
                      </Link>
                    ) : (
                      <span className="text-ink-4">—</span>
                    )}
                  </td>
                </tr>
                {isExpanded && (
                  <tr
                    className="border-b border-rule-2 bg-canvas"
                    data-testid={`log-detail-${c.id}`}
                  >
                    <td colSpan={6} className="px-5 py-4">
                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-ink-3">
                            Input
                          </div>
                          <pre className="max-h-96 overflow-y-auto overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-rule bg-paper px-3 py-2 font-mono text-[11px] text-ink-2">
                            {prettyJson(c.toolInput)}
                          </pre>
                        </div>
                        <div>
                          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-ink-3">
                            Output
                          </div>
                          <pre
                            className={`max-h-96 overflow-y-auto overflow-x-auto whitespace-pre-wrap break-all rounded-md border px-3 py-2 font-mono text-[11px] ${
                              isErr
                                ? 'border-err/25 text-err bg-paper'
                                : 'border-rule bg-paper text-ink-2'
                            }`}
                          >
                            {prettyJson(c.toolOutput)}
                          </pre>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
