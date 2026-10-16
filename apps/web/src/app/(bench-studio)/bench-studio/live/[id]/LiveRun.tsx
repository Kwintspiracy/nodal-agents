'use client';

// Le fil d'un lancement, tel que RunManager le diffuse (SSE) : chaque étape de
// chaque essai. Rien n'est déduit ici que l'événement ne dise : l'étape, le
// temps écoulé depuis le début de l'essai, l'arbre de jobs lu dans la base.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { JobTreeView, RunEvent } from '@nodal-agents/bench/studio';
import { duree } from '@nodal-agents/bench/results';
import Banner from '@/components/ui/Banner';
import PrimaryButton from '@/components/ui/PrimaryButton';
import StatusPill from '@/components/ui/StatusPill';
import Table, {
  CellChevron,
  CellMono,
  CellMuted,
  CellText,
  CellTitle,
  TableDetailNote,
  TableDetailRow,
  THead,
  Td,
  Th,
  Tr,
} from '@/components/ui/Table';
import { Panel } from '../../_components/StudioPage';
import VerdictPill from '../../_components/VerdictPill';

interface TrialRow {
  index: number;
  total: number;
  scenario: string;
  startedAt: number;
  endedAt: number | null;
  step: string;
  why: string | null;
  rootJobId: string | null;
  jobs: number | null;
  liveJobs: number | null;
  toolCalls: number | null;
  verdict: string | null;
  reasons: string[];
}

function rows(events: RunEvent[]): TrialRow[] {
  const byIndex = new Map<number, TrialRow>();
  for (const e of events) {
    if (e.type === 'trial-start') {
      byIndex.set(e.index, {
        index: e.index,
        total: e.total,
        scenario: e.scenario,
        startedAt: e.at,
        endedAt: null,
        step: 'starting',
        why: null,
        rootJobId: null,
        jobs: null,
        liveJobs: null,
        toolCalls: null,
        verdict: null,
        reasons: [],
      });
    }
    const r = 'index' in e ? byIndex.get(e.index) : undefined;
    if (!r) continue;
    if (e.type === 'progress') {
      const p = e.event;
      r.step = p.step;
      r.why = p.step === 'waiting' ? p.why : null;
      if ('rootJobId' in p) r.rootJobId = p.rootJobId;
      if (p.step === 'running') {
        r.jobs = p.jobs;
        r.liveJobs = p.liveJobs;
        r.toolCalls = p.toolCalls;
      }
    } else if (e.type === 'trial-end') {
      r.endedAt = e.at;
      r.step = 'done';
      r.verdict = e.line.verdict;
      r.reasons = e.line.reasons;
      r.rootJobId = e.line.rootJobId ?? r.rootJobId;
      r.jobs = e.line.jobs;
      r.toolCalls = e.line.toolCalls;
      r.liveJobs = 0;
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

const STEP_LABEL: Record<string, string> = {
  starting: 'Starting',
  waiting: 'Waiting',
  preparing: 'Preparing',
  started: 'Sent',
  running: 'Running',
  judging: 'Judging',
  done: 'Done',
};

export default function LiveRun({ id, webUrl }: { id: string; webUrl: string }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    const es = new EventSource(`/bench-studio/api/runs/${id}/events`);
    // Chaque (re)connexion rejoue tout le fil : on repart de zéro.
    es.onopen = () => setEvents([]);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data as string) as RunEvent;
      setEvents((l) => [...l, e]);
      if (e.type === 'done' || e.type === 'error') es.close();
    };
    return () => es.close();
  }, [id]);

  const finished = events.some((e) => e.type === 'done' || e.type === 'error');
  useEffect(() => {
    if (finished) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [finished]);

  const trials = useMemo(() => rows(events), [events]);
  const end = events.find((e) => e.type === 'done' || e.type === 'error');
  const logs = events.filter((e) => e.type === 'log');
  const total = trials[0]?.total ?? null;

  async function cancel(): Promise<void> {
    setCancelling(true);
    try {
      const r = await fetch(`/bench-studio/api/runs/${id}/cancel`, { method: 'POST' });
      const body = (await r.json()) as { ok: true } | { error: string };
      if ('error' in body) toast.error(body.error);
      else toast.success('Cancel requested: no trial starts any more, live trials are cancelled.');
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        {!end ? (
          <StatusPill variant="run" />
        ) : end.type === 'error' ? (
          <StatusPill variant="lvl-err" label="Stopped" />
        ) : (
          <StatusPill variant="done" label="Finished" />
        )}
        <span className="text-body-13 text-ink-3">
          {trials.filter((t) => t.endedAt !== null).length}
          {total !== null ? ` of ${total}` : ''} trial(s) done
          {end?.type === 'done' && end.failed > 0 ? ` · ${end.failed} not green` : ''}
          {end?.type === 'done' && end.skipped > 0 ? ` · ${end.skipped} skipped` : ''}
        </span>
        {!finished && (
          <PrimaryButton
            variant="danger"
            size="sm"
            className="ml-auto"
            disabled={cancelling}
            onClick={() => void cancel()}
          >
            {cancelling ? 'Cancelling…' : 'Cancel run'}
          </PrimaryButton>
        )}
      </div>
      {end?.type === 'error' && <Banner variant="warn">{end.message}</Banner>}

      <Table>
        <THead>
          <Th className="w-8"> </Th>
          <Th>Trial</Th>
          <Th>Step</Th>
          <Th align="right">Elapsed</Th>
          <Th align="right" className="hidden md:table-cell">
            Jobs · tools
          </Th>
          <Th className="hidden sm:table-cell">Run</Th>
        </THead>
        <tbody>
          {trials.length === 0 && (
            <Tr hover={false}>
              <Td colSpan={6}>
                <CellMuted>Waiting for the first trial…</CellMuted>
              </Td>
            </Tr>
          )}
          {trials.map((t) => (
            <Fragment key={t.index}>
              <Tr
                interactive
                expanded={open === t.index}
                onClick={() => setOpen((o) => (o === t.index ? null : t.index))}
              >
                <Td>
                  <CellChevron expanded={open === t.index} />
                </Td>
                <Td>
                  <CellTitle meta={`${t.index} / ${t.total}`}>{t.scenario}</CellTitle>
                </Td>
                <Td>
                  {t.verdict !== null ? (
                    <VerdictPill verdict={t.verdict} />
                  ) : (
                    <span title={t.why ?? undefined}>
                      <StatusPill
                        variant={t.step === 'waiting' ? 'warn' : 'run'}
                        label={STEP_LABEL[t.step] ?? t.step}
                      />
                    </span>
                  )}
                </Td>
                <Td align="right">
                  <CellMono>{duree((t.endedAt ?? now) - t.startedAt)}</CellMono>
                </Td>
                <Td align="right" className="hidden md:table-cell">
                  <CellMono>
                    {t.jobs === null
                      ? '·'
                      : `${t.jobs}${t.liveJobs ? ` (${t.liveJobs} live)` : ''} · ${t.toolCalls ?? 0}`}
                  </CellMono>
                </Td>
                <Td className="hidden sm:table-cell">
                  {t.rootJobId ? (
                    <CellText href={`${webUrl}/runs/${t.rootJobId}`}>Open in Nodal</CellText>
                  ) : (
                    <CellMuted>not sent yet</CellMuted>
                  )}
                </Td>
              </Tr>
              {open === t.index && (
                <TableDetailRow colSpan={6} label="Job tree">
                  <JobTree rootId={t.rootJobId} live={t.endedAt === null} />
                  {t.reasons.length > 0 && (
                    <ul className="mt-3 flex flex-col gap-1 text-body-13 text-ink-2">
                      {t.reasons.map((r) => (
                        <li key={r}>· {r}</li>
                      ))}
                    </ul>
                  )}
                  {t.why && <TableDetailNote>{t.why}</TableDetailNote>}
                </TableDetailRow>
              )}
            </Fragment>
          ))}
        </tbody>
      </Table>

      <Panel title={`Log · ${logs.length} line(s)`}>
        <pre className="max-h-72 overflow-auto text-mono-12 whitespace-pre-wrap text-ink-3">
          {logs.map((l) => (l.type === 'log' ? l.line : '')).join('\n') || 'Nothing logged yet.'}
        </pre>
      </Panel>
    </div>
  );
}

function JobTree({ rootId, live }: { rootId: string | null; live: boolean }) {
  const [tree, setTree] = useState<JobTreeView | { error: string } | null>(null);
  useEffect(() => {
    if (!rootId) return;
    let stop = false;
    const read = () =>
      void fetch(`/bench-studio/api/tree/${rootId}`)
        .then(async (r) => (await r.json()) as JobTreeView | { error: string })
        .then((v) => {
          if (!stop) setTree(v);
        });
    read();
    const t = live ? setInterval(read, 4000) : null;
    return () => {
      stop = true;
      if (t) clearInterval(t);
    };
  }, [rootId, live]);

  if (!rootId) return <TableDetailNote>The request has not been sent yet.</TableDetailNote>;
  if (tree === null) return <TableDetailNote>Reading the tree…</TableDetailNote>;
  if ('error' in tree) return <TableDetailNote>{tree.error}</TableDetailNote>;
  const children = (parent: string | null) => tree.jobs.filter((j) => j.parentJobId === parent);
  const render = (id: string, depth: number): React.ReactNode =>
    tree.jobs
      .filter((j) => j.id === id)
      .map((j) => (
        <Fragment key={j.id}>
          <li className="flex items-center gap-2 py-1" style={{ paddingLeft: depth * 20 }}>
            <StatusPill
              variant={
                j.status === 'completed'
                  ? 'done'
                  : j.status === 'failed' || j.status === 'cancelled'
                    ? 'lvl-err'
                    : 'run'
              }
              label={j.status ?? 'unknown'}
            />
            <span className="text-medium-13 text-ink">{j.agent ?? 'unknown agent'}</span>
            <span className="text-mono-11 text-ink-4">{j.id.slice(0, 8)}</span>
          </li>
          {children(j.id).map((c) => render(c.id, depth + 1))}
        </Fragment>
      ));
  return (
    <div>
      <ul className="flex flex-col">{render(tree.rootId, 0)}</ul>
      <p className="mt-2 text-body-12 text-ink-4">
        {tree.jobs.length} job(s), {tree.toolCalls} tool call(s)
      </p>
    </div>
  );
}
