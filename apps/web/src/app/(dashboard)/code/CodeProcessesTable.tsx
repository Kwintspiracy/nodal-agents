'use client';

// CodeProcessesTable — la page /code, organisée PAR PROJET (décision Quentin
// 25/08) : « ce qui est intéressant, c'est de suivre le développement d'un
// produit » — pas une liste plate de sessions où trois items consécutifs
// concernent le même repo sans que rien ne le dise.
//
// Trois niveaux :
//   1. Les PROJETS (dérivés : racine git / workspace des fichiers touchés) —
//      une carte par projet : sessions, agents, dernière activité, coût.
//      Les sessions inclassables vivent dans le tiroir « Other sessions ».
//   2. Un projet ouvert = sa CHRONOLOGIE de sessions (la table existante,
//      filtrée) — les agents deviennent les acteurs de l'histoire du projet.
//   3. Le détail d'une session (/code/[id]) est inchangé.
//
// L'ARCHIVAGE est un état d'UI persisté (code_project_archives) : le projet
// sort de l'espace actif, le dossier réel n'est jamais touché, désarchivage
// en un clic depuis la section « Archived ».
//
// Poll : listCodingProcessesAction toutes les 5s tant qu'une session est en
// 'coding' — le regroupement est recalculé à chaque rafraîchissement.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  listCodingProcessesAction,
  setCodeProjectArchivedAction,
  type CodingProcessRow,
} from '@/lib/actions.ts';
import Table, { THead, Th, Tr, Td } from '@/components/ui/Table';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import AgentAvatar from '@/components/ui/AgentAvatar';
import RowActionButton from '@/components/ui/RowActionButton';
import TextButton from '@/components/ui/TextButton';
import { relativeTime } from '@/lib/format-time';

const POLL_INTERVAL = 5000;

/** Clé du tiroir des sessions sans projet dérivable. Jamais archivable. */
const OTHER_KEY = '__other__';

const STAGE_LABEL: Record<string, string> = {
  coding: 'Coding',
  delegated: 'Delegated',
  review: 'Review',
  done: 'Done',
  done_approved: 'Done · Approved',
  failed: 'Failed',
  chat: 'Chat',
  awaiting_approval: 'Blocked',
};

function stageVariant(stage: string): StatusVariant {
  if (stage === 'coding' || stage === 'delegated' || stage === 'review') return 'run';
  if (stage === 'done' || stage === 'done_approved') return 'done';
  if (stage === 'failed' || stage === 'awaiting_approval') return 'warn';
  return 'idle';
}

function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage;
}

function processHref(row: CodingProcessRow): string {
  return `/code/${row.kind}-${row.id}`;
}

type Project = {
  key: string;
  name: string;
  path: string | null;
  sessions: CodingProcessRow[];
  agentNames: string[];
  totalCostUsd: number;
  lastActivityAt: string | null;
  /** Étape de la session la plus récente — l'état « vivant » du projet. */
  latestStage: string;
};

function groupProjects(rows: CodingProcessRow[]): Project[] {
  const byKey = new Map<string, Project>();
  // rows arrivent triées par activité décroissante — la première session d'un
  // groupe est donc la plus récente, et l'ordre des projets suit.
  for (const row of rows) {
    const key = row.projectPath ?? OTHER_KEY;
    const existing = byKey.get(key);
    if (existing) {
      existing.sessions.push(row);
      existing.totalCostUsd += row.costUsd;
      if (row.agentName && !existing.agentNames.includes(row.agentName)) {
        existing.agentNames.push(row.agentName);
      }
    } else {
      byKey.set(key, {
        key,
        name: row.projectName ?? 'Other sessions',
        path: row.projectPath,
        sessions: [row],
        agentNames: row.agentName ? [row.agentName] : [],
        totalCostUsd: row.costUsd,
        lastActivityAt: row.activityAt,
        latestStage: row.stage,
      });
    }
  }
  return Array.from(byKey.values());
}

export default function CodeProcessesTable({
  initialRows,
  initialArchivedPaths,
  error,
}: {
  initialRows: CodingProcessRow[];
  initialArchivedPaths: string[];
  error?: string;
}) {
  const [rows, setRows] = useState<CodingProcessRow[]>(initialRows);
  const [archived, setArchived] = useState<Set<string>>(() => new Set(initialArchivedPaths));
  const [selected, setSelected] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // A ref mirrors `rows` so the polling effect can read the latest list
  // without depending on it (an interval that resets every fetch would never
  // hold steady at 5s). Synced in an effect, never during render.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    const hasCoding = () => rowsRef.current.some((r) => r.stage === 'coding');
    if (!hasCoding()) return;

    const id = setInterval(() => {
      if (!hasCoding()) return;
      void listCodingProcessesAction().then((result) => {
        if (result.ok) setRows(result.data);
      });
    }, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [rows]);

  const projects = useMemo(() => groupProjects(rows), [rows]);
  const activeProjects = projects.filter((p) => p.path === null || !archived.has(p.path));
  const archivedProjects = projects.filter((p) => p.path !== null && archived.has(p.path));

  function toggleArchive(project: Project, nextArchived: boolean) {
    if (!project.path) return;
    const path = project.path;
    setArchived((prev) => {
      const next = new Set(prev);
      if (nextArchived) next.add(path);
      else next.delete(path);
      return next;
    });
    void setCodeProjectArchivedAction({ projectPath: path, archived: nextArchived }).then((r) => {
      if (!r.ok) {
        // Revert optimiste — l'état affiché ne doit jamais mentir sur la base.
        setArchived((prev) => {
          const next = new Set(prev);
          if (nextArchived) next.delete(path);
          else next.add(path);
          return next;
        });
        toast.error(r.message);
        return;
      }
      toast.success(
        nextArchived
          ? `${project.name} archived. The folder itself is untouched.`
          : `${project.name} restored.`,
      );
    });
  }

  if (error) {
    return (
      <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center text-body-14 text-err">
        {error}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center text-body-14 text-ink-4">
        No coding activity yet. Every pipeline that edits code files shows up here — grouped by
        project (the git repo or workspace it touched). Ask an agent to write some code and watch
        the project appear.
      </div>
    );
  }

  // ── Niveau 2 : la chronologie d'UN projet ─────────────────────────────────
  const openProject = selected ? projects.find((p) => p.key === selected) : null;
  if (openProject) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <TextButton onClick={() => setSelected(null)}>← Projects</TextButton>
          <span className="text-medium-15 text-ink">{openProject.name}</span>
          {openProject.path && (
            <code className="text-mono-12 text-ink-4" title={openProject.path}>
              {openProject.path}
            </code>
          )}
          <span className="text-body-13 text-ink-4">
            {openProject.sessions.length} session{openProject.sessions.length === 1 ? '' : 's'}
          </span>
        </div>
        <SessionsTable rows={openProject.sessions} />
      </div>
    );
  }

  // ── Niveau 1 : les projets ────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div className="space-y-2.5">
        {activeProjects.map((p) => (
          <ProjectCard
            key={p.key}
            project={p}
            onOpen={() => setSelected(p.key)}
            onArchive={p.path ? () => toggleArchive(p, true) : undefined}
          />
        ))}
        {activeProjects.length === 0 && (
          <p className="rounded-2xl border border-rule-2 bg-paper px-6 py-8 text-center text-body-14 text-ink-4">
            Everything is archived. Restore a project below to bring it back.
          </p>
        )}
      </div>

      {archivedProjects.length > 0 && (
        <div className="space-y-2.5">
          <TextButton
            onClick={() => setShowArchived((v) => !v)}
            className="!text-mono-11 uppercase tracking-[0.12em]"
          >
            {showArchived ? '▾' : '▸'} Archived · {archivedProjects.length}
          </TextButton>
          {showArchived &&
            archivedProjects.map((p) => (
              <ProjectCard
                key={p.key}
                project={p}
                dimmed
                onOpen={() => setSelected(p.key)}
                onUnarchive={() => toggleArchive(p, false)}
              />
            ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  dimmed = false,
  onOpen,
  onArchive,
  onUnarchive,
}: {
  project: Project;
  dimmed?: boolean;
  onOpen: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
}) {
  const live = project.sessions.some((s) => s.stage === 'coding');
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-2xl border border-rule-2 bg-paper px-5 py-4 ${
        dimmed ? 'opacity-60' : ''
      }`}
    >
      <RowActionButton
        onClick={onOpen}
        className="!h-auto !min-w-0 !flex-1 !justify-start !rounded-lg !border-transparent !bg-transparent !p-0 !text-left"
      >
        <span className="block min-w-0">
          <span className="flex items-center gap-2.5">
            <span className="truncate text-medium-15 text-ink">{project.name}</span>
            <StatusPill
              variant={stageVariant(project.latestStage)}
              label={stageLabel(project.latestStage)}
            />
            {live && <span className="animate-pulse text-body-12 text-ink-4">Live…</span>}
          </span>
          {project.path && (
            <code className="mt-0.5 block truncate text-mono-12 text-ink-4" title={project.path}>
              {project.path}
            </code>
          )}
        </span>
      </RowActionButton>

      <div className="flex shrink-0 items-center gap-4">
        <span className="flex items-center -space-x-1.5">
          {project.agentNames.slice(0, 3).map((n) => (
            <AgentAvatar key={n} name={n} size="sm" shape="round" />
          ))}
          {project.agentNames.length > 3 && (
            <span className="pl-2.5 text-mono-11 text-ink-4">+{project.agentNames.length - 3}</span>
          )}
        </span>
        <span className="text-mono-12 text-ink-3">
          {project.sessions.length} session{project.sessions.length === 1 ? '' : 's'}
        </span>
        <span className="hidden text-mono-12 text-ink-3 sm:inline">
          {project.totalCostUsd > 0 ? `$${project.totalCostUsd.toFixed(2)}` : '—'}
        </span>
        <span className="text-mono-12 text-ink-4">{relativeTime(project.lastActivityAt)}</span>
        {onArchive && (
          <RowActionButton onClick={onArchive} title="Archive (UI only — the folder is untouched)">
            Archive
          </RowActionButton>
        )}
        {onUnarchive && (
          <RowActionButton onClick={onUnarchive} title="Restore to the active list">
            Restore
          </RowActionButton>
        )}
      </div>
    </div>
  );
}

/** La table de sessions (l'ancienne liste plate), désormais TOUJOURS scopée à un projet. */
function SessionsTable({ rows }: { rows: CodingProcessRow[] }) {
  return (
    <Table>
      <THead>
        <Th>Agent</Th>
        <Th>Task</Th>
        <Th className="hidden md:table-cell">Origin</Th>
        <Th className="hidden lg:table-cell">Ran on</Th>
        <Th>Stage</Th>
        <Th align="right" className="hidden sm:table-cell">
          Files
        </Th>
        <Th align="right" className="hidden sm:table-cell">
          Cost
        </Th>
        <Th align="right">Age</Th>
      </THead>
      <tbody>
        {rows.map((row) => (
          <Tr key={`${row.kind}-${row.id}`}>
            <Td>
              <Link href={processHref(row)} className="flex items-center gap-2.5">
                <AgentAvatar name={row.agentName ?? '?'} size="md" shape="round" />
                <span className="truncate text-medium-14 leading-[1.2]! text-ink">
                  {row.agentName ?? 'Unknown agent'}
                </span>
              </Link>
            </Td>
            <Td className="max-w-[320px]">
              <Link
                href={processHref(row)}
                className="line-clamp-1 text-body-14 text-ink-2 transition-colors hover:text-ink"
                title={row.task}
              >
                {row.task}
              </Link>
            </Td>
            <Td className="hidden md:table-cell">
              <MonoMicroTag tone="ink">{row.origin}</MonoMicroTag>
            </Td>
            {/* Quel CLI a REELLEMENT execute. Enregistre depuis toujours dans
                cli_runs.provider : un run dont on ignore l executant ne peut
                etre ni lu pour la securite ni attribue pour le cout. */}
            <Td className="hidden lg:table-cell">
              {row.providers.length > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {row.providers.map((p) => (
                    <MonoMicroTag key={p} tone="ink">
                      {p}
                    </MonoMicroTag>
                  ))}
                </span>
              ) : (
                <span className="text-mono-12 text-ink-4">—</span>
              )}
            </Td>
            <Td>
              <StatusPill variant={stageVariant(row.stage)} label={stageLabel(row.stage)} />
            </Td>
            <Td align="right" className="hidden text-mono-12 text-ink-3 sm:table-cell">
              {row.filesChanged > 0 ? row.filesChanged : '—'}
            </Td>
            <Td align="right" className="hidden text-mono-12 text-ink-3 sm:table-cell">
              {row.costUsd > 0 ? `$${row.costUsd.toFixed(2)}` : '—'}
            </Td>
            <Td align="right" className="text-mono-12 text-ink-4">
              {relativeTime(row.activityAt)}
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
