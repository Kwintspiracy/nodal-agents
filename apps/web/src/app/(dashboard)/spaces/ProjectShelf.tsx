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
import CopyablePath from '@/components/ui/CopyablePath';
import DisclosureButton from '@/components/ui/DisclosureButton';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import type { ProjectFilesView, ProjectPageView } from '@/lib/project-actions.ts';
import { relativeTime } from '@/lib/format-time';

/**
 * CE QUE LA PREUVE DIT, en une ligne — exporté pour être prouvé sans navigateur.
 *
 * Le dernier verdict d'abord (c'est le fait), puis les comptes, puis l'état de
 * la configuration. Rien d'absent ne s'écrit : un projet où rien n'a tourné ne
 * dit pas « 0 sequences », il n'en parle pas.
 */
export function proofLine(proof: ProjectPageView['proof']): string {
  const parts: string[] = [];
  const derniere = proof.sequences.at(-1);
  if (derniere) {
    // `green` est le seul verdict qui prouve quelque chose. Les deux autres
    // disent « pas prouvé », et ils ne disent pas la même chose : un rouge
    // vient du projet, une erreur d'infrastructure vient d'ici.
    parts.push(
      derniere.verdict === 'green'
        ? 'green'
        : derniere.verdict === 'red'
          ? 'failed'
          : 'could not run',
    );
    parts.push(plural(proof.sequences.length, 'run', 'runs'));
  }
  if (proof.configured) {
    parts.push(plural(proof.commands?.length ?? 0, 'command', 'commands'));
    parts.push(proof.approval === 'approved' ? 'approved' : 'waiting for your approval');
  } else {
    parts.push('No command declared.');
  }
  return parts.join(' · ');
}

/** Le singulier et le pluriel, pour ne jamais écrire « 1 commands ». */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Au-delà, la liste se replie : une étagère se survole, elle ne se lit pas. */
const FOLDED_AT = 20;

/**
 * Ce qu'on dit quand le dossier n'a pas pu être lu. Une phrase par CAUSE
 * (revue passe 30, constat 3) : annoncer une suppression là où il n'y a qu'un
 * refus de permission envoie chercher un dossier qui est toujours là.
 */
const UNREADABLE_TEXT: Record<NonNullable<ProjectFilesView['unreadable']>, string> = {
  absent: 'This folder is not there any more.',
  not_a_directory: 'This path is not a folder.',
  permission: 'This folder cannot be read (permission).',
  error: 'This folder cannot be read.',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ProjectShelf({
  project,
  files,
  proof,
}: {
  project: ProjectPageView['project'];
  files: ProjectPageView['files'];
  proof: ProjectPageView['proof'];
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
          {files.unreadable === null && (
            <span className="text-mono-11 text-ink-4">
              {files.entries.length + files.more} at the top level
              {files.ignored > 0 ? ` · ${files.ignored} ignored` : ''}
            </span>
          )}
        </div>
        {files.unreadable !== null ? (
          // Un dossier illisible est DIT (inv. #4) : un projet vide et un
          // projet dont le dossier a disparu ne se ressemblent pas.
          <p className="px-4 py-3 text-body-13 text-warn">
            {UNREADABLE_TEXT[files.unreadable]} Nothing was read.
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
                    {/* Un lien porte sa flèche : l'étagère ne le fait pas
                        passer pour un fichier du projet. */}
                    {e.kind === 'dir'
                      ? `${e.name}/`
                      : e.kind === 'symlink'
                        ? `${e.name} →`
                        : e.name}
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
                  insetY="tight"
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

      {/* La preuve, en UNE ligne : le dernier verdict et ses comptes. Les
          COMMANDES sont juste en dessous, dans leur propre carte.
          Il y avait trois couches ici (Quentin, 19/09) : cette ligne, un bloc
          replié « VERIFICATION · 2 · GREEN · 2 sequences… » découpé par le
          bord du panneau, et la carte des commandes. Trois façons de dire le
          même état, dont deux qu'on ne lisait pas. */}
      <section className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="shrink-0 text-medium-13 text-ink">Proof</span>
          <span
            className="min-w-0 flex-1 truncate text-body-12 text-ink-3"
            title={proofLine(proof)}
          >
            {proofLine(proof)}
          </span>
        </div>
      </section>
    </div>
  );
}
