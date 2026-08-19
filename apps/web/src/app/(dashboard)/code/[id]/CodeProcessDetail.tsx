'use client';

// CodeProcessDetail — the /code/[id] mission-control view: header, review
// verdicts, a collapsible tool-call timeline (typed cards per tool), and a
// Changes panel. Polls getCodingProcessDetailAction every 4s while the
// process is still in the 'coding' stage — new tool calls appear at the
// bottom, same interval-effect shape as CodeProcessesTable's list poller.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  getCodingProcessDetailAction,
  type CodingProcessDetail as CodingProcessDetailData,
  type CodingToolCallView,
  type CodingChangeView,
  type CodingVerdictView,
} from '@/lib/actions.ts';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import DisclosureButton from '@/components/ui/DisclosureButton';
import TextButton from '@/components/ui/TextButton';
import { relativeTime } from '@/lib/format-time';

const POLL_INTERVAL = 4000;
const LINE_LIMIT = 16;

const STAGE_LABEL: Record<string, string> = {
  coding: 'Coding',
  delegated: 'Delegated',
  review: 'Review',
  done: 'Done',
  done_approved: 'Done · Approved',
  failed: 'Failed',
  chat: 'Chat',
};

function stageVariant(stage: string): StatusVariant {
  if (stage === 'coding' || stage === 'delegated' || stage === 'review') return 'run';
  if (stage === 'done' || stage === 'done_approved') return 'done';
  if (stage === 'failed') return 'warn';
  return 'idle';
}

function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage;
}

export default function CodeProcessDetail({
  query,
  initialDetail,
}: {
  query: { jobId: string } | { sessionId: string };
  initialDetail: CodingProcessDetailData;
}) {
  const [detail, setDetail] = useState(initialDetail);
  // Synced in an effect, never during render (react-hooks/refs).
  const stageRef = useRef(detail.header.stage);
  useEffect(() => {
    stageRef.current = detail.header.stage;
  }, [detail.header.stage]);

  useEffect(() => {
    if (stageRef.current !== 'coding') return;
    const id = setInterval(() => {
      if (stageRef.current !== 'coding') return;
      void getCodingProcessDetailAction(query).then((result) => {
        if (result.ok) setDetail(result.data);
      });
    }, POLL_INTERVAL);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.header.stage]);

  const { header, toolCalls, verdicts, changes } = detail;

  return (
    <div className="space-y-6">
      <Link href="/code" className="text-body-13 text-ink-3 hover:text-ink-2">
        ← Code
      </Link>

      {/* Header */}
      <div className="space-y-4 rounded-xl border border-rule-2 bg-paper p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-medium-15 text-ink">{header.agentName ?? 'Unknown agent'}</span>
          <MonoMicroTag tone="ink">{header.origin}</MonoMicroTag>
          <StatusPill variant={stageVariant(header.stage)} label={stageLabel(header.stage)} />
          {header.stage === 'coding' && (
            <span className="animate-pulse text-body-12 text-ink-4">Live…</span>
          )}
        </div>
        <p className="text-body-14 leading-[1.5]! text-ink-2">{header.task}</p>
        <div className="grid grid-cols-2 gap-2 text-body-13 sm:grid-cols-4">
          {[
            ['Cost', header.costUsd > 0 ? `$${header.costUsd.toFixed(2)}` : '—'],
            [
              'Duration',
              header.durationMs != null ? `${(header.durationMs / 1000).toFixed(1)}s` : '—',
            ],
            ['Files changed', String(header.filesChanged)],
            ['Activity', relativeTime(header.activityAt)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-rule-2 bg-canvas px-3 py-2">
              <p className="text-mono-11 tracking-wider text-ink-4 uppercase">{label}</p>
              <p className="mt-0.5 truncate font-mono text-ink-2">{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Review verdicts */}
      {verdicts.length > 0 && (
        <div className="space-y-3 rounded-xl border border-rule-2 bg-paper p-5">
          <h2 className="text-mono-11 tracking-wider text-ink-4 uppercase">Review verdicts</h2>
          {verdicts.map((v, i) => (
            <VerdictCard key={i} verdict={v} />
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Tool call timeline */}
        <div className="overflow-hidden rounded-xl border border-rule-2 bg-paper lg:col-span-2">
          <h2 className="border-b border-rule-2 px-4 py-3 text-mono-11 tracking-wider text-ink-4 uppercase">
            Tool calls{toolCalls.length > 0 ? ` · ${toolCalls.length}` : ''}
          </h2>
          {toolCalls.length === 0 ? (
            <p className="px-4 py-6 text-body-13 text-ink-4">
              {header.kind === 'chat'
                ? "Chat sessions don't record a tool-call timeline yet, only their run history."
                : 'No tool calls recorded yet.'}
            </p>
          ) : (
            <div>
              {toolCalls.map((tc) => (
                <ToolCallRow key={tc.id} tc={tc} />
              ))}
            </div>
          )}
        </div>

        {/* Changes panel */}
        <div className="self-start overflow-hidden rounded-xl border border-rule-2 bg-paper">
          <h2 className="border-b border-rule-2 px-4 py-3 text-mono-11 tracking-wider text-ink-4 uppercase">
            Changes{changes.length > 0 ? ` · ${changes.length}` : ''}
          </h2>
          {changes.length === 0 ? (
            <p className="px-4 py-6 text-body-13 text-ink-4">No files changed yet.</p>
          ) : (
            <div>
              {changes.map((c, i) => (
                <ChangeRow key={i} change={c} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Tool-call row + typed expanded cards ──────────────────────────────────

/** file_path (cli:Edit/Write/MultiEdit), notebook_path (cli:NotebookEdit), or path (file_edit/file_write). */
function inputFilePath(input: Record<string, unknown>): string {
  if (typeof input['file_path'] === 'string') return input['file_path'];
  if (typeof input['notebook_path'] === 'string') return input['notebook_path'];
  if (typeof input['path'] === 'string') return input['path'];
  return '';
}

const FILE_TOOL_LABEL: Record<string, string> = {
  'cli:Edit': 'Edit',
  'cli:Write': 'Write',
  'cli:MultiEdit': 'MultiEdit',
  'cli:NotebookEdit': 'NotebookEdit',
  file_edit: 'Edit file',
  file_write: 'Write file',
};

function summarizeToolCall(tc: CodingToolCallView): { shortName: string; summary: string } {
  const input = (tc.toolInput ?? {}) as Record<string, unknown>;
  if (tc.toolName === 'code_task') {
    return {
      shortName: 'Code Task',
      summary: typeof input['task'] === 'string' ? input['task'] : '',
    };
  }
  if (tc.toolName === 'review_verdict') {
    return { shortName: 'Review', summary: '' };
  }
  if (FILE_TOOL_LABEL[tc.toolName]) {
    return { shortName: FILE_TOOL_LABEL[tc.toolName]!, summary: inputFilePath(input) };
  }
  if (tc.toolName.startsWith('cli:')) {
    const bare = tc.toolName.slice('cli:'.length);
    if (bare === 'Bash') {
      return {
        shortName: 'Bash',
        summary: typeof input['command'] === 'string' ? input['command'] : '',
      };
    }
    return { shortName: bare, summary: inputFilePath(input) };
  }
  return { shortName: tc.toolName, summary: '' };
}

function dotColorForTool(toolName: string): string {
  if (FILE_TOOL_LABEL[toolName]) return 'bg-ok';
  if (toolName === 'cli:Bash') return 'bg-warn';
  if (toolName === 'review_verdict') return 'bg-run';
  if (toolName === 'code_task') return 'bg-agent-vivid';
  return 'bg-ink-3';
}

function ToolCallRow({ tc }: { tc: CodingToolCallView }) {
  const [open, setOpen] = useState(false);
  const { shortName, summary } = summarizeToolCall(tc);
  return (
    <div className="border-b border-rule-2 last:border-0">
      <DisclosureButton open={open} onClick={() => setOpen((v) => !v)}>
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColorForTool(tc.toolName)}`}
          aria-hidden
        />
        <span className="w-24 shrink-0 text-medium-13 text-ink">{shortName}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-body-13 text-ink-3">{summary}</span>
        {tc.delegatedFrom && (
          <MonoMicroTag tone="agent" className="shrink-0">
            delegated{tc.delegatedFrom.agentName ? ` · ${tc.delegatedFrom.agentName}` : ''}
          </MonoMicroTag>
        )}
        {tc.durationMs != null && (
          <span className="shrink-0 text-mono-11 text-ink-4">{tc.durationMs}ms</span>
        )}
      </DisclosureButton>
      {open && <div className="px-4 pb-4 pl-9">{renderToolCallCard(tc)}</div>}
    </div>
  );
}

type VerdictJsonLike = {
  verdict?: string;
  summary?: string;
  findings?: Array<{ file?: string; line?: number; severity?: string; issue?: string }>;
  counts?: Record<string, number>;
};

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function renderToolCallCard(tc: CodingToolCallView) {
  const input = (tc.toolInput ?? {}) as Record<string, unknown>;

  if (tc.toolName === 'cli:Edit' || tc.toolName === 'file_edit') {
    const filePath = inputFilePath(input) || 'Unknown file';
    const oldText = typeof input['old_string'] === 'string' ? input['old_string'] : null;
    const newText = typeof input['new_string'] === 'string' ? input['new_string'] : null;
    return <DiffBlock filePath={filePath} oldText={oldText} newText={newText} />;
  }
  if (tc.toolName === 'cli:Write' || tc.toolName === 'file_write') {
    const filePath = inputFilePath(input) || 'Unknown file';
    const content = typeof input['content'] === 'string' ? input['content'] : null;
    return <DiffBlock filePath={filePath} oldText={null} newText={content} />;
  }
  if (tc.toolName === 'cli:MultiEdit') {
    const filePath = inputFilePath(input) || 'Unknown file';
    const edits = Array.isArray(input['edits']) ? input['edits'] : [];
    const olds: string[] = [];
    const news: string[] = [];
    for (const e of edits) {
      if (!e || typeof e !== 'object') continue;
      const rec = e as Record<string, unknown>;
      if (typeof rec['old_string'] === 'string') olds.push(rec['old_string']);
      if (typeof rec['new_string'] === 'string') news.push(rec['new_string']);
    }
    return (
      <DiffBlock
        filePath={filePath}
        oldText={olds.length > 0 ? olds.join('\n') : null}
        newText={news.length > 0 ? news.join('\n') : null}
      />
    );
  }
  if (tc.toolName === 'cli:NotebookEdit') {
    const filePath = inputFilePath(input) || 'Unknown notebook';
    const oldText = typeof input['old_source'] === 'string' ? input['old_source'] : null;
    const newText =
      typeof input['new_source'] === 'string'
        ? input['new_source']
        : typeof input['content'] === 'string'
          ? input['content']
          : null;
    return <DiffBlock filePath={filePath} oldText={oldText} newText={newText} />;
  }
  if (tc.toolName === 'cli:Bash') {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    return <TerminalBlock command={command} output={tc.toolOutput} />;
  }
  if (tc.toolName === 'cli:Read') {
    const filePath = inputFilePath(input) || 'Unknown file';
    return <ReadBlock filePath={filePath} content={tc.toolOutput} />;
  }
  if (tc.toolName === 'review_verdict') {
    const parsed = tc.toolOutput ? safeJsonParse<VerdictJsonLike>(tc.toolOutput) : null;
    if (parsed) {
      return (
        <VerdictCard
          verdict={{
            jobId: '',
            verdict: parsed.verdict ?? null,
            summary: parsed.summary ?? null,
            findings: parsed.findings ?? [],
            counts: parsed.counts ?? null,
          }}
        />
      );
    }
    return <GenericCard toolInput={tc.toolInput} toolOutput={tc.toolOutput} />;
  }
  if (tc.toolName === 'code_task') {
    return <CodeTaskResultCard toolInput={tc.toolInput} toolOutput={tc.toolOutput} />;
  }
  return <GenericCard toolInput={tc.toolInput} toolOutput={tc.toolOutput} />;
}

function CollapsibleLines({
  text,
  tone = 'default',
}: {
  text: string;
  tone?: 'default' | 'add' | 'remove' | 'terminal';
}) {
  const lines = text.split('\n');
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? lines : lines.slice(0, LINE_LIMIT);
  const hasMore = lines.length > LINE_LIMIT;
  const toneClass =
    tone === 'add'
      ? 'bg-ok-bg text-ok'
      : tone === 'remove'
        ? 'bg-warn-bg text-err'
        : tone === 'terminal'
          ? 'bg-ink text-canvas'
          : 'bg-hover text-ink-2';
  return (
    <div>
      <pre
        className={`overflow-x-auto rounded-md px-3 py-2 text-mono-12 leading-[1.5]! whitespace-pre ${toneClass}`}
      >
        {visible.join('\n')}
      </pre>
      {hasMore && !expanded && (
        <TextButton
          onClick={() => setExpanded(true)}
          className="mt-1 text-body-12 text-ink-4 underline hover:text-ink-3"
        >
          Show all ({lines.length} lines)
        </TextButton>
      )}
    </div>
  );
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => `${prefix} ${l}`)
    .join('\n');
}

function DiffBlock({
  filePath,
  oldText,
  newText,
}: {
  filePath: string;
  oldText: string | null;
  newText: string | null;
}) {
  const oldCount = oldText ? oldText.split('\n').length : 0;
  const newCount = newText ? newText.split('\n').length : 0;
  return (
    <div className="space-y-2">
      <div className="font-mono text-body-13 font-semibold text-ink">{filePath}</div>
      {oldText !== null && <CollapsibleLines text={prefixLines(oldText, '−')} tone="remove" />}
      {newText !== null && <CollapsibleLines text={prefixLines(newText, '+')} tone="add" />}
      <p className="text-body-12 text-ink-4">
        +{newCount} −{oldCount} lines
      </p>
    </div>
  );
}

function TerminalBlock({ command, output }: { command: string; output: string | null }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 font-mono text-body-13 text-ink">
        <span className="text-ink-4">$</span>
        <span className="truncate">{command || '(no command)'}</span>
      </div>
      {output && <CollapsibleLines text={output} tone="terminal" />}
    </div>
  );
}

function ReadBlock({ filePath, content }: { filePath: string; content: string | null }) {
  return (
    <div className="space-y-2">
      <div className="font-mono text-body-13 font-semibold text-ink">{filePath}</div>
      {content ? (
        <CollapsibleLines text={content} tone="default" />
      ) : (
        <p className="text-body-13 text-ink-4">No content recorded.</p>
      )}
    </div>
  );
}

function VerdictCard({ verdict }: { verdict: CodingVerdictView }) {
  const approved = verdict.verdict === 'approve';
  return (
    <div className="space-y-2">
      <StatusPill
        variant={approved ? 'done' : 'warn'}
        label={approved ? 'Approve' : (verdict.verdict ?? 'Request changes')}
      />
      {verdict.summary && <p className="text-body-13 text-ink-2">{verdict.summary}</p>}
      {verdict.findings.length > 0 && (
        <ul className="space-y-1.5">
          {verdict.findings.map((f, i) => (
            <li key={i} className="rounded-md border border-rule-2 px-3 py-2 text-body-13">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-mono-12 text-ink-3">
                  {f.file ?? 'Unknown file'}
                  {f.line ? `:${f.line}` : ''}
                </span>
                {f.severity && <MonoMicroTag tone="warn">{f.severity}</MonoMicroTag>}
              </div>
              {f.issue && <p className="mt-1 text-ink-2">{f.issue}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CodeTaskResultCard({
  toolInput,
  toolOutput,
}: {
  toolInput: unknown;
  toolOutput: string | null;
}) {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  const parsedOutput = toolOutput
    ? safeJsonParse<{ resultText?: string; isError?: boolean }>(toolOutput)
    : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {typeof input['provider'] === 'string' && (
          <MonoMicroTag tone="ink">{input['provider']}</MonoMicroTag>
        )}
        {typeof input['mode'] === 'string' && (
          <MonoMicroTag tone="ink">{input['mode']}</MonoMicroTag>
        )}
      </div>
      {typeof input['task'] === 'string' && (
        <p className="text-body-13 text-ink-2">{input['task']}</p>
      )}
      {parsedOutput?.resultText ? (
        <CollapsibleLines text={parsedOutput.resultText} tone="default" />
      ) : (
        toolOutput && <CollapsibleLines text={toolOutput} tone="default" />
      )}
    </div>
  );
}

function GenericCard({ toolInput, toolOutput }: { toolInput: unknown; toolOutput: string | null }) {
  return (
    <div className="space-y-2">
      <CollapsibleLines text={JSON.stringify(toolInput, null, 2)} tone="default" />
      {toolOutput && <CollapsibleLines text={toolOutput} tone="default" />}
    </div>
  );
}

// ─── Changes panel row ──────────────────────────────────────────────────────

function ChangeRow({ change }: { change: CodingChangeView }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-rule-2 last:border-0">
      <DisclosureButton open={open} onClick={() => setOpen((v) => !v)}>
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${change.kind === 'edit' ? 'bg-ok' : 'bg-run'}`}
          aria-hidden
        />
        <span
          className="min-w-0 flex-1 truncate font-mono text-body-13 text-ink-2"
          title={change.filePath}
        >
          {change.filePath}
        </span>
        <MonoMicroTag tone={change.kind === 'edit' ? 'skill' : 'ink'}>{change.kind}</MonoMicroTag>
      </DisclosureButton>
      {open && (
        <div className="px-4 pb-4 pl-9">
          <DiffBlock filePath={change.filePath} oldText={change.oldText} newText={change.newText} />
        </div>
      )}
    </div>
  );
}
