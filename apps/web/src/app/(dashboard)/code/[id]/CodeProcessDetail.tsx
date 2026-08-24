'use client';

// CodeProcessDetail — the /code/[id] mission-control view (v5, Quentin 19/08
// fourth pass): an accordion of every file's full diff didn't scale (15
// files × 2000 lines). Layout now:
//   - Left sidebar: the list of changed files (name + churn counter). Click
//     to select; first file selected by default.
//   - Central panel: the SELECTED file's diff only, independently
//     scrollable, with the compact Activity trail underneath it.
// Activity itself is unchanged in content from the previous pass: one line
// per tool_call (icon, short name, target, duration, delegated badge) with
// NO diff/output content inline — expanding a row shows only its raw
// input/output JSON. Review verdicts keep their own rich card (a synthesis,
// not a routine tool call), above the two-column layout. Turn markers (from
// llm_calls / cli_runs — never guessed) are intercalated into Activity for
// the only token/cost granularity the data actually supports: per turn,
// never per tool.
//
// Polls getCodingProcessDetailAction every 4s while the process is still in
// the 'coding' stage — same interval-effect shape as CodeProcessesTable's
// list poller.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { diffLines } from '@/lib/line-diff';
import {
  getCodingProcessDetailAction,
  listApprovalsAction,
  type ApprovalRow,
  type CodingProcessDetail as CodingProcessDetailData,
  type CodingToolCallView,
  type CodingActivityItem,
  type CodingFileChangeGroup,
  type CodingChangeView,
  type CodingVerdictView,
} from '@/lib/actions.ts';
import ApprovalActions from '@/app/(dashboard)/approvals/ApprovalActions.tsx';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import DisclosureButton from '@/components/ui/DisclosureButton';
import TextButton from '@/components/ui/TextButton';
import PillTabs from '@/components/ui/PillTabs';
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
  awaiting_approval: 'Blocked · needs approval',
};

/**
 * Étapes où le process est encore VIVANT — la sonde continue de tourner.
 * `coding` seul était faux deux fois : un process délégué/en review bougeait
 * sans rafraîchir, et un process BLOQUÉ sur approbation figeait l'écran au
 * moment précis où l'utilisateur doit agir (punch list V1.1).
 */
const LIVE_STAGES = new Set(['coding', 'delegated', 'review', 'awaiting_approval']);

function stageVariant(stage: string): StatusVariant {
  if (stage === 'coding' || stage === 'delegated' || stage === 'review') return 'run';
  if (stage === 'done' || stage === 'done_approved') return 'done';
  if (stage === 'failed' || stage === 'awaiting_approval') return 'warn';
  return 'idle';
}

function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage;
}

/**
 * PathTail — truncates a long path from the START, keeping the filename
 * (the end) visible instead of the drive/root (Quentin, 19/08 fifth pass).
 * Standard CSS trick: the container flips to `dir="rtl"` + `text-align:
 * left`, so the browser's ellipsis cuts the LEFT side of the box; the `<bdi
 * dir="ltr">` inside keeps the path's own characters (and punctuation like
 * `:` or `\`) reading left-to-right rather than being reversed by the outer
 * RTL context. Full path always available via the native `title` tooltip.
 */
function PathTail({
  text,
  title,
  className = '',
}: {
  text: string;
  /** Full path for the hover tooltip, when `text` is only a fragment (e.g. FileListRow's separate name/dir lines). Defaults to `text`. */
  title?: string;
  className?: string;
}) {
  return (
    <span
      dir="rtl"
      title={title ?? text}
      className={`block overflow-hidden text-left text-ellipsis whitespace-nowrap ${className}`}
    >
      <bdi dir="ltr">{text}</bdi>
    </span>
  );
}

export default function CodeProcessDetail({
  query,
  initialDetail,
  embedded = false,
}: {
  query: { jobId: string } | { sessionId: string };
  initialDetail: CodingProcessDetailData;
  /**
   * true = rendu DANS le poste de travail projet (/code, rail de sessions à
   * gauche) : pas de lien « ← Code », pas de titre projet (le contexte projet
   * vit au-dessus) — le titre redevient l'agent, acteur de la session.
   */
  embedded?: boolean;
}) {
  const [detail, setDetail] = useState(initialDetail);
  // Synced in an effect, never during render (react-hooks/refs).
  const stageRef = useRef(detail.header.stage);
  useEffect(() => {
    stageRef.current = detail.header.stage;
  }, [detail.header.stage]);

  // Approbations en attente appartenant à CE pipeline. Chargées avec la même
  // cadence que le détail ; résolues → le prochain tick les efface.
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRow[]>([]);
  const pipelineIdsRef = useRef(detail.pipelineJobIds);
  useEffect(() => {
    pipelineIdsRef.current = detail.pipelineJobIds;
  }, [detail.pipelineJobIds]);

  useEffect(() => {
    if (!LIVE_STAGES.has(stageRef.current)) return;
    let cancelled = false;
    const tick = () => {
      if (!LIVE_STAGES.has(stageRef.current)) return;
      void getCodingProcessDetailAction(query).then((result) => {
        if (result.ok && !cancelled) setDetail(result.data);
      });
      void listApprovalsAction({ status: 'pending' }).then((result) => {
        if (!result.ok || cancelled) return;
        const ids = new Set(pipelineIdsRef.current);
        setPendingApprovals(result.data.filter((a) => ids.has(a.jobId)));
      });
    };
    const id = setInterval(tick, POLL_INTERVAL);
    // Premier chargement des approbations sans attendre 4s — un process déjà
    // bloqué au moment où la page s'ouvre doit montrer sa carte tout de suite.
    const first = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      clearInterval(id);
      clearTimeout(first);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.header.stage]);

  const { header, activity, verdicts, changes } = detail;

  // Agent filter for the Activity trail — only worth showing once delegation
  // actually happened (root + at least one distinct delegated agent).
  const [agentFilter, setAgentFilter] = useState('all');
  const agentFilters = buildAgentFilters(activity, header.agentName);
  const totalCalls = activity.filter((item) => item.kind === 'call').length;
  // Turn markers are pipeline-wide, not per-agent — they only make sense in
  // the "All" view (Quentin, 19/08).
  const visibleActivity =
    agentFilter === 'all'
      ? activity
      : activity.filter((item) => item.kind === 'call' && agentKeyForCall(item) === agentFilter);

  return (
    <div className="space-y-6">
      {!embedded && (
        <Link href="/code" className="text-body-13 text-ink-3 hover:text-ink-2">
          ← Code
        </Link>
      )}

      {/* Header — le PROJET d'abord (décision Quentin 25/08 : « si j'ouvre un
          projet, la chose importante c'est le projet ») ; l'agent devient un
          acteur, en tag. Sans projet dérivable — ou en mode embarqué, où le
          projet titre déjà le poste de travail — l'agent reste le titre. */}
      <div className="space-y-4 rounded-xl border border-rule-2 bg-paper p-5">
        <div className="flex flex-wrap items-center gap-3">
          {!embedded && header.projectName ? (
            <>
              <span className="text-medium-15 text-ink" title={header.projectPath ?? undefined}>
                {header.projectName}
              </span>
              <MonoMicroTag tone="agent">{header.agentName ?? 'Unknown agent'}</MonoMicroTag>
            </>
          ) : (
            <span className="text-medium-15 text-ink">{header.agentName ?? 'Unknown agent'}</span>
          )}
          <MonoMicroTag tone="ink">{header.origin}</MonoMicroTag>
          {/* Quel CLI a execute — la seule facon de lire un run pour la
              securite (les deux ne confinent pas pareil, cf. PR #6) et de lui
              attribuer son cout. */}
          {header.providers.map((p) => (
            <MonoMicroTag key={p} tone="ink">
              {p}
            </MonoMicroTag>
          ))}
          <StatusPill variant={stageVariant(header.stage)} label={stageLabel(header.stage)} />
          {header.stage === 'coding' && (
            <span className="animate-pulse text-body-12 text-ink-4">Live…</span>
          )}
        </div>
        <p className="text-body-14 leading-[1.5]! text-ink-2">{header.task}</p>
        <div className="grid grid-cols-2 gap-2 text-body-13 sm:grid-cols-3 lg:grid-cols-7">
          {[
            ['Cost', header.costUsd > 0 ? `$${header.costUsd.toFixed(2)}` : '—'],
            [
              'Duration',
              header.durationMs != null ? `${(header.durationMs / 1000).toFixed(1)}s` : '—',
            ],
            ['Input tokens', header.inputTokens > 0 ? header.inputTokens.toLocaleString() : '—'],
            ['Output tokens', header.outputTokens > 0 ? header.outputTokens.toLocaleString() : '—'],
            ['Cache reads', header.cachedTokens > 0 ? header.cachedTokens.toLocaleString() : '—'],
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

      {/* Approbations en attente du pipeline — la carte inline (punch list
          V1.1, pattern dsh : bande ambre, justification, action, refuse/allow).
          Au-dessus de tout : c'est la seule chose qui BLOQUE le process. */}
      {pendingApprovals.map((a) => (
        <div
          key={a.id}
          className="space-y-3 rounded-xl border border-warn/40 border-l-4 border-l-warn bg-paper p-5"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-medium-14 text-ink">⏸ {a.explanation.what}</span>
            <MonoMicroTag tone="ink">{a.agentName ?? 'agent'}</MonoMicroTag>
            <span className="text-mono-11 text-ink-4">{a.toolName}</span>
          </div>
          <div className="space-y-1.5 rounded-md border border-rule-2 bg-canvas px-3 py-2">
            <p className="text-body-13 italic text-ink-2">
              {a.explanation.purpose
                ? `« ${a.explanation.purpose} »`
                : "L'agent n'a pas expliqué pourquoi."}
            </p>
            <p className="text-body-12 text-warn">
              ⚠️ {a.explanation.effectLabel}
              {a.explanation.target && (
                <span className="text-ink-2"> → {a.explanation.target}</span>
              )}
            </p>
            {a.explanation.args.length > 0 && (
              <dl className="space-y-0.5 pt-0.5">
                {a.explanation.args.map((arg) => (
                  <div key={arg.key} className="flex gap-2 text-mono-12">
                    <dt className="shrink-0 text-ink-3">{arg.key}</dt>
                    <dd className="min-w-0 break-all text-ink-2">
                      {arg.value}
                      {arg.truncated && (
                        <span className="text-ink-3">
                          {' '}
                          ({arg.fullLength} caractères, 300 affichés)
                        </span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <ApprovalActions
            approvalId={a.id}
            toolName={a.toolName}
            agentId={a.agentId}
            mcpRulePattern={a.mcpRulePattern}
            mcpServerName={a.explanation.provenance.name ?? null}
          />
        </div>
      ))}

      {/* v7 (spec Quentin 25/08) : UNE colonne, dans l'ordre — verdict de
          review condensé (extensible), fichiers repliables façon PR review
          (chevron + chemin + −N +N, diff à l'ouverture), puis l'activité
          chronologique de TOUS les agents. Plus de sidebar de fichiers ni de
          panneau central : les colonnes étroites, « ça ne va pas du tout ». */}
      <VerdictsSection verdicts={verdicts} stage={header.stage} />

      <div className="overflow-hidden rounded-xl border border-rule-2 bg-paper">
        <h2 className="border-b border-rule-2 px-4 py-3 text-mono-11 tracking-wider text-ink-4 uppercase">
          Files{changes.length > 0 ? ` · ${changes.length}` : ''}
        </h2>
        {changes.length === 0 ? (
          <p className="px-4 py-6 text-body-13 text-ink-4">No files changed yet.</p>
        ) : (
          changes.map((group) => <FileDiffRow key={group.filePath} group={group} />)
        )}
      </div>

      {/* Activity — la chronologie de la session, tous agents confondus. */}
      <div className="overflow-hidden rounded-xl border border-rule-2 bg-paper">
        <h2 className="border-b border-rule-2 px-4 py-3 text-mono-11 tracking-wider text-ink-4 uppercase">
          Activity{activity.length > 0 ? ` · ${activity.length}` : ''}
        </h2>
        {agentFilters.length > 1 && (
          <div className="border-b border-rule-2 px-4 py-2.5">
            <PillTabs
              tabs={[
                { value: 'all', label: 'All', count: totalCalls },
                ...agentFilters.map((a) => ({ value: a.key, label: a.label, count: a.count })),
              ]}
              value={agentFilter}
              onChange={setAgentFilter}
              variant="inset"
            />
          </div>
        )}
        {activity.length === 0 ? (
          <p className="px-4 py-6 text-body-13 text-ink-4">
            {header.kind === 'chat'
              ? "Chat sessions don't record a tool-call trail yet, only their run history."
              : 'No activity recorded yet.'}
          </p>
        ) : (
          <div className="max-h-[70vh] overflow-y-auto">
            {visibleActivity.map((item, i) =>
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

// ─── Review verdict — condensé d'abord, complet sur demande ──────────────────

/** Le statut condensé d'une review — lisible en une demi-seconde. */
function verdictStatus(verdicts: CodingVerdictView[], stage: string) {
  if (verdicts.length === 0) {
    if (stage === 'review') return { variant: 'run' as StatusVariant, label: 'Review in progress' };
    return null;
  }
  const last = verdicts[verdicts.length - 1]!;
  return last.verdict === 'approve'
    ? { variant: 'done' as StatusVariant, label: 'Approved' }
    : { variant: 'warn' as StatusVariant, label: 'Changes requested' };
}

function VerdictsSection({ verdicts, stage }: { verdicts: CodingVerdictView[]; stage: string }) {
  const [open, setOpen] = useState(false);
  const status = verdictStatus(verdicts, stage);
  if (!status) return null;
  const last = verdicts[verdicts.length - 1] ?? null;

  return (
    <div className="overflow-hidden rounded-xl border border-rule-2 bg-paper">
      <DisclosureButton
        open={open}
        onClick={() => verdicts.length > 0 && setOpen((v) => !v)}
        className="w-full px-4 py-3"
      >
        <span className="text-mono-11 uppercase tracking-wider text-ink-4">Review</span>
        <StatusPill variant={status.variant} label={status.label} />
        {last?.summary && !open && (
          <span className="min-w-0 truncate text-body-13 text-ink-3">{last.summary}</span>
        )}
        {verdicts.length > 1 && (
          <span className="ml-auto shrink-0 text-mono-11 text-ink-4">
            {verdicts.length} verdicts
          </span>
        )}
      </DisclosureButton>
      {open && (
        <div className="space-y-3 border-t border-rule-2 px-4 py-4">
          {verdicts.map((v, i) => (
            <VerdictCard key={i} verdict={v} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Fichiers repliables façon PR review (spec Quentin, image CodeRabbit) ────

function FileDiffRow({ group }: { group: CodingFileChangeGroup }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-rule-2 last:border-b-0">
      <DisclosureButton
        open={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-2.5"
      >
        <PathTail
          text={group.filePath}
          className="min-w-0 flex-1 font-mono text-body-13 text-ink"
        />
        <span className="shrink-0 text-mono-11">
          {group.removedLines > 0 && <span className="text-err">−{group.removedLines}</span>}{' '}
          {group.addedLines > 0 && <span className="text-ok">+{group.addedLines}</span>}
        </span>
      </DisclosureButton>
      {open && (
        <div className="space-y-3 border-t border-rule-2 bg-canvas/50 px-4 py-4">
          {group.edits.map((edit, i) => (
            <EditHunk key={i} edit={edit} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Split diff (spec Quentin 25/08, maquette CodeRabbit/GitHub) ─────────────
// Le classique côte à côte ligne contre ligne : ancien à gauche (suppressions
// en rouge), nouveau à droite (ajouts en vert), lignes alignées, cellule vide
// grisée en face d'une ligne sans vis-à-vis, runs inchangés repliés en
// « N unmodified lines ». Construit sur diffLines (LCS maison, line-diff.ts).

type SplitCell = { n: number; text: string; changed: boolean } | null;
type SplitRow =
  | { kind: 'line'; left: SplitCell; right: SplitCell }
  | { kind: 'elided'; count: number };

/** Apparie le script d'ops LCS en lignes gauche/droite alignées (style GitHub). */
function buildSplitRows(oldText: string, newText: string): SplitRow[] {
  const ops = diffLines(oldText, newText);
  const rows: SplitRow[] = [];
  let ln = 0; // numéro de ligne gauche (relatif au hunk)
  let rn = 0; // numéro de ligne droite

  let i = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.op === 'same') {
      // Run de lignes inchangées — contexte de 3 de chaque côté, le reste replié.
      let j = i;
      while (j < ops.length && ops[j]!.op === 'same') j++;
      const run = ops.slice(i, j);
      const CONTEXT = 3;
      const isFirst = i === 0;
      const isLast = j === ops.length;
      // En bord de fichier, un seul côté de contexte est utile.
      const head = isFirst ? 0 : CONTEXT;
      const tail = isLast ? 0 : CONTEXT;
      run.forEach((line, k) => {
        const inHead = k < head;
        const inTail = k >= run.length - tail;
        if (run.length > head + tail + 1 && !inHead && !inTail) {
          ln++;
          rn++;
          const prev = rows[rows.length - 1];
          if (prev && prev.kind === 'elided') prev.count++;
          else rows.push({ kind: 'elided', count: 1 });
        } else {
          ln++;
          rn++;
          rows.push({
            kind: 'line',
            left: { n: ln, text: line.text, changed: false },
            right: { n: rn, text: line.text, changed: false },
          });
        }
      });
      i = j;
      continue;
    }
    // Run de changements : les suppressions puis les ajouts contigus sont
    // appariés rangée par rangée — l'excédent d'un côté fait face à du vide.
    const removes: string[] = [];
    const adds: string[] = [];
    while (i < ops.length && ops[i]!.op !== 'same') {
      if (ops[i]!.op === 'remove') removes.push(ops[i]!.text);
      else adds.push(ops[i]!.text);
      i++;
    }
    const len = Math.max(removes.length, adds.length);
    for (let k = 0; k < len; k++) {
      const left = k < removes.length ? { n: ++ln, text: removes[k]!, changed: true } : null;
      const right = k < adds.length ? { n: ++rn, text: adds[k]!, changed: true } : null;
      rows.push({ kind: 'line', left, right });
    }
  }
  return rows;
}

function SplitDiffCell({ cell, side }: { cell: SplitCell; side: 'left' | 'right' }) {
  // Cellule sans vis-à-vis : le hachuré sombre de la maquette, rendu en fond
  // neutre appuyé — rien à lire de ce côté.
  if (!cell) {
    return (
      <>
        <span className="select-none border-r border-rule-2 bg-hover px-2" />
        <span className="bg-hover" />
      </>
    );
  }
  const tone = cell.changed ? (side === 'left' ? 'bg-err/10' : 'bg-ok/10') : '';
  const numTone = cell.changed
    ? side === 'left'
      ? 'bg-err/15 text-err'
      : 'bg-ok/15 text-ok'
    : 'text-ink-4';
  return (
    <>
      <span
        className={`select-none border-r border-rule-2 px-2 text-right font-mono text-mono-11 leading-[1.6] ${numTone}`}
      >
        {cell.n}
      </span>
      <span
        className={`whitespace-pre px-2 font-mono text-mono-12 leading-[1.6] text-ink-2 ${tone}`}
      >
        {cell.text || ' '}
      </span>
    </>
  );
}

const SPLIT_ROW_LIMIT = 80;

/** Bloc brut repliable — utilisé par Activity pour l'input/output JSON. */
function CollapsibleLines({ text }: { text: string; tone?: 'default' }) {
  const lines = text.split('\n');
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? lines : lines.slice(0, LINE_LIMIT);
  const hasMore = lines.length > LINE_LIMIT;
  return (
    <div>
      <pre className="overflow-x-auto rounded-md bg-hover px-3 py-2 text-mono-12 leading-[1.5]! whitespace-pre text-ink-2">
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

function EditHunk({ edit }: { edit: CodingChangeView }) {
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(
    () => buildSplitRows(edit.oldText ?? '', edit.newText ?? ''),
    [edit.oldText, edit.newText],
  );
  const visible = expanded ? rows : rows.slice(0, SPLIT_ROW_LIMIT);
  const hasMore = rows.length > SPLIT_ROW_LIMIT;

  return (
    <div>
      <div className="overflow-x-auto rounded-md border border-rule-2 bg-canvas">
        <div className="grid min-w-[640px] grid-cols-[3rem_minmax(0,1fr)_3rem_minmax(0,1fr)]">
          {visible.map((row, i) =>
            row.kind === 'elided' ? (
              <div
                key={i}
                className="col-span-4 border-y border-rule-2 bg-hover px-3 py-1 font-mono text-mono-11 text-ink-4"
              >
                {row.count} unmodified line{row.count === 1 ? '' : 's'}
              </div>
            ) : (
              <div key={i} className="col-span-4 grid grid-cols-subgrid">
                <SplitDiffCell cell={row.left} side="left" />
                <SplitDiffCell cell={row.right} side="right" />
              </div>
            ),
          )}
        </div>
      </div>
      {hasMore && !expanded && (
        <TextButton
          onClick={() => setExpanded(true)}
          className="mt-1 text-body-12 text-ink-4 underline hover:text-ink-3"
        >
          Show all ({rows.length} lines)
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

function summarizeToolCall(tc: CodingToolCallView): {
  shortName: string;
  summary: string;
  /** Whether `summary` is a file path (tail-truncate it) vs a command/description (truncate normally — the START matters more there). */
  isPath: boolean;
} {
  const input = (tc.toolInput ?? {}) as Record<string, unknown>;
  if (tc.toolName === 'code_task') {
    return {
      shortName: 'Code Task',
      summary: typeof input['task'] === 'string' ? input['task'] : '',
      isPath: false,
    };
  }
  if (tc.toolName === 'review_verdict') {
    return { shortName: 'Review', summary: '', isPath: false };
  }
  if (FILE_TOOL_LABEL[tc.toolName]) {
    return {
      shortName: FILE_TOOL_LABEL[tc.toolName]!,
      summary: inputFilePath(input),
      isPath: true,
    };
  }
  if (tc.toolName.startsWith('cli:')) {
    const bare = tc.toolName.slice('cli:'.length);
    if (bare === 'Bash') {
      return {
        shortName: 'Bash',
        summary: typeof input['command'] === 'string' ? input['command'] : '',
        isPath: false,
      };
    }
    // cli:Read / cli:Glob / cli:Grep etc. — still path-shaped targets.
    return { shortName: bare, summary: inputFilePath(input), isPath: true };
  }
  return { shortName: tc.toolName, summary: '', isPath: false };
}

/** Groups a 'call' activity item to its owning agent — root job (sentinel key) or a delegated child, grouped by AGENT NAME (Quentin, 19/08: "chaque agent délégué DISTINCT", not per job — two delegate jobs to the same reviewer agent share one chip). Falls back to the job id only when the child has no resolvable agent name. */
function agentKeyForCall(item: Extract<CodingActivityItem, { kind: 'call' }>): string {
  if (!item.delegatedFrom) return '__root__';
  return item.delegatedFrom.agentName ?? `job:${item.delegatedFrom.jobId}`;
}

type AgentFilterOption = { key: string; label: string; count: number };

function buildAgentFilters(
  activity: CodingActivityItem[],
  rootAgentName: string | null,
): AgentFilterOption[] {
  const byKey = new Map<string, AgentFilterOption>();
  for (const item of activity) {
    if (item.kind !== 'call') continue;
    const key = agentKeyForCall(item);
    const label = item.delegatedFrom
      ? (item.delegatedFrom.agentName ?? 'Delegated agent')
      : (rootAgentName ?? 'Unknown agent');
    const existing = byKey.get(key);
    if (existing) existing.count += 1;
    else byKey.set(key, { key, label, count: 1 });
  }
  // Root first, then delegated agents in first-appearance order.
  const root = byKey.get('__root__');
  const rest = Array.from(byKey.values()).filter((o) => o.key !== '__root__');
  return root ? [root, ...rest] : rest;
}

function dotColorForTool(toolName: string): string {
  if (FILE_TOOL_LABEL[toolName]) return 'bg-ok';
  if (toolName === 'cli:Bash') return 'bg-warn';
  if (toolName === 'review_verdict') return 'bg-run';
  if (toolName === 'code_task') return 'bg-agent-vivid';
  return 'bg-ink-3';
}

/**
 * A call the harness REFUSED — it did nothing. Detected from the CLI's
 * `<tool_use_error>` envelope (or a Nodal builtin's `{"ok":false}`). Kept
 * VISIBLE and flagged rather than hidden: "this agent tried to write and was
 * blocked" is the signal that tells you its posture is wrong — the one that
 * was missing while a read-only agent looked like it was coding for a day.
 */
function isRefusedCall(toolOutput: string | null): boolean {
  if (!toolOutput) return false;
  const head = toolOutput.slice(0, 400);
  return head.includes('<tool_use_error>') || /^\s*\{"ok"\s*:\s*false\b/.test(head);
}

function ActivityRow({ tc }: { tc: CodingToolCallView }) {
  const [open, setOpen] = useState(false);
  const { shortName, summary, isPath } = summarizeToolCall(tc);
  const refused = isRefusedCall(tc.toolOutput);
  return (
    <div className="border-b border-rule-2 last:border-0">
      <DisclosureButton open={open} onClick={() => setOpen((v) => !v)}>
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColorForTool(tc.toolName)}`}
          aria-hidden
        />
        <span className="w-24 shrink-0 text-medium-13 text-ink">{shortName}</span>
        {isPath ? (
          <PathTail text={summary} className="min-w-0 flex-1 font-mono text-body-13 text-ink-3" />
        ) : (
          <span
            className="min-w-0 flex-1 truncate font-mono text-body-13 text-ink-3"
            title={summary}
          >
            {summary}
          </span>
        )}
        {refused && (
          <MonoMicroTag tone="err" className="shrink-0">
            refused
          </MonoMicroTag>
        )}
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
  // inputTokens est l'EFFECTIF (hors cache, lectures ET écritures) — même
  // sémantique pour les tours Nodal et CLI. Le détail cache vit dans le
  // title (hover).
  const cacheParts = [
    item.cachedTokens > 0 ? `${item.cachedTokens.toLocaleString()} cache reads` : null,
    item.cacheCreationTokens != null && item.cacheCreationTokens > 0
      ? `${item.cacheCreationTokens.toLocaleString()} cache writes`
      : null,
  ].filter(Boolean);
  // % du prompt servi par le cache = lectures / (lectures + écritures +
  // effectif). Les écritures comptent au dénominateur : un run qui AMORCE son
  // cache (writes >> reads) n'est pas « caché », il paie plein pot ×1,25.
  const promptTotal =
    item.cachedTokens + (item.cacheCreationTokens ?? 0) + Math.max(0, item.inputTokens);
  const cachedPct = promptTotal > 0 ? Math.round((item.cachedTokens / promptTotal) * 100) : 0;
  return (
    <div className="border-b border-rule-2 bg-canvas/50 last:border-0">
      <div
        className="flex flex-wrap items-center gap-2 px-4 py-2 text-mono-11 text-ink-4"
        title={cacheParts.length > 0 ? cacheParts.join(' · ') : undefined}
      >
        <span className="tracking-wider uppercase">{label}</span>
        <span>·</span>
        <span>
          {item.inputTokens.toLocaleString()} in / {item.outputTokens.toLocaleString()} out
        </span>
        {item.cachedTokens > 0 && (
          <>
            <span>·</span>
            <span>{cachedPct}% cached</span>
          </>
        )}
        {item.costUsd > 0 && (
          <>
            <span>·</span>
            <span>${item.costUsd.toFixed(4)}</span>
          </>
        )}
      </div>
      {/* Per-model split (0079): a CLI turn can be served by several models —
          the main one plus any sub-agent the CLI spawned on another tier.
          Rendered only when the provider actually reported the split, and only
          when it says something the line above doesn't (2+ models). */}
      {item.modelUsage && item.modelUsage.length > 1 && (
        <div className="flex flex-col gap-0.5 px-4 pb-2 pl-6 text-mono-11 text-ink-4">
          {item.modelUsage.map((m) => (
            <div key={m.model} className="flex flex-wrap items-center gap-2">
              <span className="text-ink-3">{m.model}</span>
              <span>
                {m.inputTokens.toLocaleString()} in / {m.outputTokens.toLocaleString()} out
              </span>
              {(m.cachedTokens > 0 || (m.cacheCreationTokens ?? 0) > 0) && (
                <span>
                  · {m.cachedTokens.toLocaleString()} cache reads
                  {m.cacheCreationTokens != null
                    ? ` / ${m.cacheCreationTokens.toLocaleString()} writes`
                    : ''}
                </span>
              )}
              {m.costUsd != null && m.costUsd > 0 && <span>· ${m.costUsd.toFixed(4)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
