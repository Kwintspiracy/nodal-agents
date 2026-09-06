'use client';

// FileDiff — un fichier de la carte « N fichiers » devient cliquable, et déplie
// ce qui a changé (P11, plan « De la maquette au produit »).
//
// PARESSEUX PAR CONSTRUCTION : rien n'est chargé au rendu du fil. Un fil de
// trente tours peut porter des centaines de fichiers ; en demander le diff à
// l'ouverture ferait autant d'appels `git` sur la machine de l'hôte pour des
// panneaux que personne n'ouvrira. Le premier clic charge, les suivants
// rouvrent ce qui est déjà là.
//
// QUAND IL N'Y A RIEN À MONTRER, ÇA SE DIT. Le runner rend un CODE ; la phrase
// est écrite ici, courte, en anglais. Un panneau vide laisserait croire à un
// fichier inchangé alors que, le plus souvent, l'écriture est simplement
// antérieure aux instantanés ou porte sur un fichier que le `.gitignore` du
// dossier exclut.

import { useState } from 'react';
import DisclosureButton from '@/components/ui/DisclosureButton';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import { fragmentDiff } from '@nodal-agents/shared';
import { getFileDiffAction, type FileDiffView } from '@/lib/file-diff-actions.ts';

/** Les raisons du runner, dites en une ligne lisible. */
const NO_DIFF: Readonly<Record<string, string>> = {
  no_checkpoint: 'written before snapshots were kept',
  path_unresolved: 'file could not be located',
  workspace_unreachable: 'folder no longer reachable',
  not_in_snapshot: "file is ignored by the folder's .gitignore",
};

type Line = { kind: '+' | '-' | ' ' | '@'; text: string };

/**
 * Les lignes d'un diff git, prêtes à peindre.
 *
 * Les en-têtes (`diff --git`, `index`, `---`, `+++`) sont retirés : ils
 * répètent un chemin déjà affiché juste au-dessus. Les `@@` restent, ce sont
 * les seules bornes qui disent qu'un morceau a été sauté.
 */
export function gitDiffLines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split('\n')) {
    if (
      raw.startsWith('diff --git') ||
      raw.startsWith('index ') ||
      raw.startsWith('--- ') ||
      raw.startsWith('+++ ') ||
      raw.startsWith('new file mode') ||
      raw.startsWith('deleted file mode') ||
      raw.startsWith('similarity index') ||
      raw.startsWith('rename ')
    ) {
      continue;
    }
    if (raw.startsWith('@@')) {
      out.push({ kind: '@', text: raw });
      continue;
    }
    if (raw === '' && out.length === 0) continue;
    if (raw.startsWith('+')) out.push({ kind: '+', text: raw.slice(1) });
    else if (raw.startsWith('-')) out.push({ kind: '-', text: raw.slice(1) });
    else if (raw.startsWith('\\')) continue;
    else out.push({ kind: ' ', text: raw.startsWith(' ') ? raw.slice(1) : raw });
  }
  return out;
}

const TONE: Readonly<Record<Line['kind'], string>> = {
  '+': 'text-ok',
  '-': 'text-err',
  ' ': 'text-ink-3',
  '@': 'text-ink-4',
};

function DiffLines({
  lines,
  truncated,
  truncatedNote = '… truncated',
}: {
  lines: Line[];
  truncated: boolean;
  /** Ce que la coupe VEUT DIRE ici : un texte coupé, ou un diff fin abandonné. */
  truncatedNote?: string;
}) {
  return (
    <div className="border-t border-rule-2 bg-sidebar px-4 py-2">
      <pre className="max-h-80 overflow-auto text-mono-11 whitespace-pre-wrap break-words">
        {lines.map((l, i) => (
          <div key={i} className={TONE[l.kind]} data-diff={l.kind}>
            {l.kind === '@' ? l.text : `${l.kind}${l.text}`}
          </div>
        ))}
      </pre>
      {truncated && <p className="pt-1 text-mono-11 text-ink-4">{truncatedNote}</p>}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-t border-rule-2 bg-sidebar px-4 py-2 text-mono-11 text-ink-4">
      {children}
    </p>
  );
}

/** Ce que le panneau montre pour une réponse donnée. Pur, donc testable seul. */
export function DiffBody({ view }: { view: FileDiffView }) {
  switch (view.kind) {
    case 'diff':
      return <DiffLines lines={gitDiffLines(view.text)} truncated={view.truncated} />;
    case 'fragment': {
      const d = fragmentDiff(view.oldString, view.newString);
      // Au-delà de la borne, `fragmentDiff` rend les deux fragments entiers en
      // bloc (rien n'est coupé) : la note dit ce qui a été abandonné — la
      // comparaison ligne à ligne — pas un contenu manquant (revue Codex,
      // passe 42).
      return (
        <DiffLines
          lines={d.lines}
          truncated={d.truncated}
          truncatedNote="diff simplified: too long to compare line by line"
        />
      );
    }
    case 'unchanged':
      return <Note>No change</Note>;
    case 'binary':
      return <Note>Binary file</Note>;
    case 'unavailable':
      return <Note>No diff: {NO_DIFF[view.reason] ?? view.reason}</Note>;
  }
}

export default function FileDiff({
  jobId,
  toolCallId,
  path,
  action,
  bytes,
  detail,
}: {
  jobId: string;
  toolCallId: string;
  path: string;
  action: string;
  bytes?: string;
  detail?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<FileDiffView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (!next || view !== null || loading) return;
    setLoading(true);
    setError(null);
    void getFileDiffAction({ jobId, toolCallId, path })
      .then((res) => {
        if (res.ok) setView(res.data);
        else setError(res.code);
      })
      .catch(() => setError('unreachable'))
      .finally(() => setLoading(false));
  };

  return (
    <li>
      <DisclosureButton open={open} onClick={toggle} className="py-1.5 text-mono-12 text-ink-2">
        <span className="min-w-0 flex-1 truncate text-left">{path}</span>
        <MonoMicroTag tone="agent">{action}</MonoMicroTag>
        {bytes !== undefined && <span className="text-ink-4">{bytes}</span>}
        {detail !== undefined && <span className="truncate text-ink-4">{detail}</span>}
      </DisclosureButton>
      {open && loading && <Note>Loading the diff…</Note>}
      {open && !loading && error !== null && <Note>No diff: {error}</Note>}
      {open && !loading && view !== null && <DiffBody view={view} />}
    </li>
  );
}
