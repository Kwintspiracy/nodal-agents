'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import type { ToolCallLogRow } from '@/lib/actions.ts';

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

export default function LogsTable({ items }: Props) {
  // Brique 37 — local UI state, no router round-trip. Toggling a row stays
  // within the page render, so pagination/filters are unaffected.
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);

  return (
    <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-800/60">
            <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider">
              Time
            </th>
            <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider">
              Tool
            </th>
            <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden md:table-cell">
              Agent
            </th>
            <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden lg:table-cell">
              Duration
            </th>
            <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden lg:table-cell">
              Job
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => {
            const isExpanded = expandedRowId === c.id;
            return (
              <Fragment key={c.id}>
                <tr
                  className={`border-b border-neutral-800/40 last:border-0 align-top cursor-pointer transition-colors ${
                    isExpanded ? 'bg-neutral-800/40' : 'hover:bg-neutral-800/20'
                  }`}
                  onClick={() => setExpandedRowId(isExpanded ? null : c.id)}
                  aria-expanded={isExpanded}
                  data-testid={`log-row-${c.id}`}
                >
                  <td className="px-5 py-3 text-xs text-neutral-500 whitespace-nowrap">
                    {c.createdAt ? new Date(c.createdAt).toLocaleTimeString() : '—'}
                    <div className="text-[10px] text-neutral-600">
                      {c.createdAt ? new Date(c.createdAt).toLocaleDateString() : ''}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <code
                      className={`font-mono text-xs ${
                        isErrorOutput(c.toolOutput) ? 'text-red-400' : 'text-violet-400'
                      }`}
                    >
                      {c.toolName}
                    </code>
                    {isErrorOutput(c.toolOutput) && (
                      <span className="ml-2 text-[10px] font-semibold text-red-400 uppercase">
                        error
                      </span>
                    )}
                    {c.turn !== null && (
                      <span className="ml-2 text-[10px] text-neutral-600">turn {c.turn}</span>
                    )}
                  </td>
                  <td
                    className="hidden md:table-cell px-5 py-3 text-xs"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {c.agentName ? (
                      <Link
                        href={`/logs?agent=${c.agentId}`}
                        className="text-neutral-300 hover:text-white"
                      >
                        {c.agentName}
                      </Link>
                    ) : (
                      <span className="text-neutral-600">—</span>
                    )}
                  </td>
                  <td className="hidden lg:table-cell px-5 py-3 text-xs text-neutral-400">
                    {formatDuration(c.durationMs)}
                  </td>
                  <td
                    className="hidden lg:table-cell px-5 py-3"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {c.jobId ? (
                      <Link
                        href={`/jobs/${c.jobId}`}
                        className="font-mono text-xs text-neutral-500 hover:text-white"
                      >
                        {c.jobId.slice(0, 8)}
                      </Link>
                    ) : (
                      <span className="text-neutral-600">—</span>
                    )}
                  </td>
                </tr>
                {isExpanded && (
                  <tr
                    className="border-b border-neutral-800/40 bg-neutral-950/50"
                    data-testid={`log-detail-${c.id}`}
                  >
                    <td colSpan={5} className="px-5 py-4">
                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">
                            Input
                          </div>
                          <pre className="text-[11px] text-neutral-300 bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all max-h-96 overflow-y-auto">
                            {prettyJson(c.toolInput)}
                          </pre>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">
                            Output
                          </div>
                          <pre
                            className={`text-[11px] bg-neutral-950 border rounded-md px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all max-h-96 overflow-y-auto ${
                              isErrorOutput(c.toolOutput)
                                ? 'text-red-300 border-red-900/40'
                                : 'text-neutral-300 border-neutral-800'
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
