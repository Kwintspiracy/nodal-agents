'use client';

// CodeProcessDetail — the /code/[id] mission-control view (v4, Quentin 19/08
// third pass): Changes (the files touched) is the MAIN content, not a
// sidebar — a card per file, path + churn counter, its edits expandable.
// Activity is a compact, secondary trail: one line per tool_call (icon,
// short name, target, duration, delegated badge) with NO diff/output content
// inline — expanding a row shows only its raw input/output JSON. Review
// verdicts keep their own rich card (a synthesis, not a routine tool call).
// Turn markers (from llm_calls / cli_runs — never guessed) are intercalated
// into Activity to show token/cost at the only granularity the data actually
// supports: per turn, never per tool.
//
// Polls getCodingProcessDetailAction every 4s while the process is still in
// the 'coding' stage — same interval-effect shape as CodeProcessesTable's
// list poller.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  getCodingProcessDetailAction,
  type CodingProcessDetail as CodingProcessDetailData,
  type CodingToolCallView,
  type CodingActivityItem,
  type CodingFileChangeGroup,
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
/** Files start expanded when there are only a handful — beyond that, collapsed by default. */
const AUTO_EXPAND_FILE_THRESHOLD = 3;

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

  const { header, activity, verdicts, changes } = detail;
  const autoExpandFiles = changes.length > 0 && changes.length <= AUTO_EXPAND_FILE_THRESHOLD;

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
        <div className="grid grid-cols-2 gap-2 text-body-13 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ['Cost', header.costUsd > 0 ? `$${header.costUsd.toFixed(2)}` : '—'],
            [
              'Duration',
              header.durationMs != null ? `${(header.durationMs / 1000).toFixed(1)}s` : '—',
            ],
            ['Input tokens', header.inputTokens > 0 ? header.inputTokens.toLocaleString() : '—'],
            ['Output tokens', header.outputTokens > 0 ? header.outputTokens.toLocaleString() : '—'],
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

      {/* Review verdicts — a synthesis, kept near the header, above Changes. */}
      {verdicts.length > 0 && (
        <div className="space-y-3 rounded-xl border border-rule-2 bg-paper p-5">
          <h2 className="text-mono-11 tracking-wider text-ink-4 uppercase">Review verdicts</h2>
          {verdicts.map((v, i) => (
            <VerdictCard key={i} verdict={v} />
          ))}
        </div>
      )}

      {/* Changes — the MAIN content: what actually changed. */}
      <div className="overflow-hidden rounded-xl border border-rule-2 bg-paper">
        <h2 className="border-b border-rule-2 px-4 py-3 text-mono-11 tracking-wider text-ink-4 uppercase">
          Changes
          {changes.length > 0 ? ` · ${changes.length} file${changes.length === 1 ? '' : 's'}` : ''}
        </h2>
        {changes.length === 0 ? (
          <p className="px-4 py-6 text-body-13 text-ink-4">No files changed yet.</p>
        ) : (
          <div>
            {changes.map((group) => (
              <FileChangeCard key={group.filePath} group={group} defaultOpen={autoExpandFiles} />
            ))}
          </div>
        )}
      </div>

      {/* Activity — compact secondary trail: metrics only, no content. */}
      <div className="overflow-hidden rounded-xl border border-rule-2 bg-paper">
        <h2 className="border-b border-rule-2 px-4 py-3 text-mono-11 tracking-wider text-ink-4 uppercase">
          Activity{activity.length > 0 ? ` · ${activity.length}` : ''}
        </h2>
        {activity.length === 0 ? (
          <p className="px-4 py-6 text-body-13 text-ink-4">
            {header.kind === 'chat'
              ? "Chat sessions don't record a tool-call trail yet, only their run history."
              : 'No activity recorded yet.'}
          </p>
        ) : (
          <div>
            {activity.map((item, i) =>
              item.kind === 'turn' ? (
                <TurnMarkerRow key={`turn-${i}`} item={item} />
              ) : (
                <ActivityRow key={item.id} tc={item} />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Changes (main content) ─────────────────────────────────────────────────

function FileChangeCard({
  group,
  defaultOpen,
}: {
  group: CodingFileChangeGroup;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-rule-2 last:border-0">
      <DisclosureButton open={open} onClick={() => setOpen((v) => !v)}>
        <span
          className="min-w-0 flex-1 truncate font-mono text-body-13 text-ink"
          title={group.filePath}
        >
          {group.filePath}
        </span>
        <span className="shrink-0 text-mono-12 text-ok">+{group.addedLines}</span>
        <span className="shrink-0 text-mono-12 text-err">−{group.removedLines}</span>
      </DisclosureButton>
      {open && (
        <div className="space-y-3 px-4 pb-4 pl-9">
          {group.edits.map((edit, i) => (
            <EditHunk key={i} edit={edit} />
          ))}
        </div>
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

function EditHunk({ edit }: { edit: CodingChangeView }) {
  return (
    <div className="space-y-1.5">
      {edit.oldText !== null && (
        <CollapsibleLines text={prefixLines(edit.oldText, '−')} tone="remove" />
      )}
      {edit.newText !== null && (
        <CollapsibleLines text={prefixLines(edit.newText, '+')} tone="add" />
      )}
    </div>
  );
}

function CollapsibleLines({
  text,
  tone = 'default',
}: {
  text: string;
  tone?: 'default' | 'add' | 'remove';
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

// ─── Review verdicts ─────────────────────────────────────────────────────────

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

// ─── Activity (compact secondary trail) ────────────────────────────────────

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

function ActivityRow({ tc }: { tc: CodingToolCallView }) {
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
      {/* No diff/output content here on purpose (Quentin, 19/08) — Activity is
          metrics-only. Expanding shows the raw input/output JSON, nothing typed. */}
      {open && (
        <div className="space-y-1.5 px-4 pb-4 pl-9">
          <CollapsibleLines text={JSON.stringify(tc.toolInput, null, 2)} tone="default" />
          {tc.toolOutput && <CollapsibleLines text={tc.toolOutput} tone="default" />}
        </div>
      )}
    </div>
  );
}

function TurnMarkerRow({ item }: { item: Extract<CodingActivityItem, { kind: 'turn' }> }) {
  const label = item.turn !== null ? `Turn ${item.turn}` : 'CLI turn';
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-rule-2 bg-canvas/50 px-4 py-2 text-mono-11 text-ink-4 last:border-0">
      <span className="tracking-wider uppercase">{label}</span>
      <span>·</span>
      <span>
        {item.inputTokens.toLocaleString()} in / {item.outputTokens.toLocaleString()} out
      </span>
      {item.costUsd > 0 && (
        <>
          <span>·</span>
          <span>${item.costUsd.toFixed(4)}</span>
        </>
      )}
    </div>
  );
}
