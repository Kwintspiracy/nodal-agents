'use client';

// ProjectShelf — l'étagère d'un projet (P8) : le dossier, ce qu'il y a dedans,
// et l'état de sa preuve.
//
// « Étagère », parce que c'est ce qu'on regarde en entrant dans un projet :
// où c'est posé, ce qu'il y a dessus, et si quelqu'un a vérifié que ça tient.
// Le fil de la conversation vient après — il se lit en descendant.
//
// Composant CLIENT pour une seule raison : au-delà de vingt entrées, la liste
// se replie, et c'est un état d'écran. Tout ce qu'il affiche lui arrive en
// props, déjà lues côté serveur.

import { useState } from 'react';
import Link from 'next/link';
import CopyablePath from '@/components/ui/CopyablePath';
import DisclosureButton from '@/components/ui/DisclosureButton';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import VerificationSection from '@/app/(dashboard)/code/[id]/VerificationSection.tsx';
import type { VerificationUnconfiguredView } from '@/lib/verification-runs-view.ts';
import type { ProjectPageView } from '@/lib/project-actions.ts';
import { relativeTime } from '@/lib/format-time';

/** Au-delà, la liste se replie : une étagère se survole, elle ne se lit pas. */
const FOLDED_AT = 20;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ProjectShelf({
  project,
  files,
  proof,
  unconfigured,
}: {
  project: ProjectPageView['project'];
  files: ProjectPageView['files'];
  proof: ProjectPageView['proof'];
  unconfigured: VerificationUnconfiguredView[];
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? files.entries : files.entries.slice(0, FOLDED_AT);
  const foldable = files.entries.length > FOLDED_AT;

  return (
    <div className="mx-auto max-w-[840px] space-y-6">
      {/* Le dossier — ce qu'un projet EST. */}
      <section className="rounded-xl border border-rule-2 bg-paper p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <MonoMicroTag tone="ink">{project.kind}</MonoMicroTag>
          {project.hidden && <MonoMicroTag tone="warn">hidden</MonoMicroTag>}
          <span className="text-body-12 text-ink-3">
            {project.agentName ?? 'No agent'} · registered from {project.registeredFrom} ·{' '}
            {relativeTime(project.registeredAt)}
          </span>
        </div>
        <CopyablePath display={project.path} value={project.path} />
      </section>

      {/* Les fichiers — le premier niveau, et rien de plus. */}
      <section className="overflow-hidden rounded-xl border border-rule-2 bg-paper">
        <div className="flex flex-wrap items-center gap-2 border-b border-rule-2 bg-sidebar px-4 py-2.5">
          <span className="text-medium-13 text-ink">Files</span>
          {!files.missing && (
            <span className="text-mono-11 text-ink-4">
              {files.entries.length + files.more} at the top level
              {files.ignored > 0 ? ` · ${files.ignored} ignored` : ''}
            </span>
          )}
        </div>
        {files.missing ? (
          // Un dossier absent est DIT (inv. #4) : un projet vide et un projet
          // dont le dossier a disparu ne se ressemblent pas.
          <p className="px-4 py-3 text-body-13 text-warn">
            This folder is not there any more. Nothing was read.
          </p>
        ) : files.entries.length === 0 ? (
          <p className="px-4 py-3 text-body-13 text-ink-4">Nothing in here yet.</p>
        ) : (
          <>
            <ul className="py-1">
              {shown.map((e) => (
                <li
                  key={e.name}
                  className="flex items-center gap-3 px-4 py-1.5 text-mono-12 text-ink-2"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {e.kind === 'dir' ? `${e.name}/` : e.name}
                  </span>
                  <span className="text-ink-4">{e.bytes === null ? '' : formatBytes(e.bytes)}</span>
                </li>
              ))}
            </ul>
            {foldable && (
              <div className="border-t border-rule-2">
                <DisclosureButton
                  open={expanded}
                  onClick={() => setExpanded(!expanded)}
                  className="py-2"
                >
                  <span className="text-body-12 text-ink-3">
                    {expanded
                      ? 'Show fewer'
                      : `Show ${files.entries.length - FOLDED_AT} more entries`}
                  </span>
                </DisclosureButton>
              </div>
            )}
            {files.more > 0 && (
              <p className="border-t border-rule-2 px-4 py-2 text-mono-11 text-ink-4">
                and {files.more} more, not read
              </p>
            )}
          </>
        )}
      </section>

      {/* La preuve — la configuration déclarée, puis ce qui a tourné. */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-body-12 text-ink-3">
          <span className="text-medium-13 text-ink">Proof</span>
          {proof.configured ? (
            <span>
              {proof.commands?.length} command
              {(proof.commands?.length ?? 0) === 1 ? '' : 's'} ·{' '}
              {proof.approval === 'approved' ? 'approved' : 'waiting for your approval'}
            </span>
          ) : (
            <span>No command declared.</span>
          )}
          {project.kind === 'code' && (
            // Il n'existe pas de route dédiée à la configuration : le panneau
            // vit sur l'écran Code, dans la carte du projet. On y renvoie, sans
            // promettre une page qui n'existe pas.
            <Link href="/code" className="text-xs text-ink-3 underline hover:text-ink-2">
              Configure proof in Code
            </Link>
          )}
        </div>
        <VerificationSection
          sequences={proof.sequences}
          skippedSurfaces={[]}
          unconfigured={unconfigured}
          stage="completed"
          live={false}
        />
      </section>
    </div>
  );
}
