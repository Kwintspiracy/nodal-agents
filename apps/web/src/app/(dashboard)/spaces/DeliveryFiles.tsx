'use client';

// DeliveryFiles — LES FICHIERS DE LA LIVRAISON, ET CE QUI A CHANGÉ DEDANS
// (issue #369).
//
// L'encart de livraison nommait les fichiers d'un run, un chemin par ligne.
// « La personne s'attendait à lire ce qui a changé » : chaque fichier porte
// maintenant la plaque de diff unifié que la page d'un run dessine déjà
// (`code/[id]/FileChangeBlock.tsx`), et c'est LA MÊME — même module de
// regroupement, même `fragmentDiff`, mêmes rangées.
//
// REPLIÉE D'ENTRÉE, contrairement à la page d'un run. L'encart conclut un
// travail AU MILIEU d'une conversation : douze diffs dépliés enterreraient la
// suite du fil. La ligne dit le chemin et « +N −M » ; le clic montre le reste.
//
// PARESSEUX, ET UN SEUL APPEL. Les fragments — l'avant et l'après de chaque
// écriture — pèsent le poids de ce qui a été écrit. Le modèle du fil ne porte
// donc que les en-têtes, et le premier dépli demande les fragments du travail
// ENTIER : ouvrir le deuxième fichier ne redemande rien. C'est la paresse de
// `FileDiff` (P11), sans le runner : ici il n'y a rien à calculer, les
// fragments sont sur les lignes d'audit.

import { useState } from 'react';
import FileChangeBlock from '@/app/(dashboard)/code/[id]/FileChangeBlock.tsx';
import { getRunFileChangesAction } from '@/lib/run-file-changes-actions.ts';
import type { CodingChangeView } from '@/lib/coding-changes.ts';
import type { DeliveryFileChange } from '@/lib/conversation-feed.ts';

/** Une plaque sans fragment garde la MÊME liste vide d'un rendu à l'autre. */
const AUCUN: CodingChangeView[] = [];

export default function DeliveryFiles({
  files,
  jobId,
}: {
  files: DeliveryFileChange[];
  jobId: string;
}) {
  const [edits, setEdits] = useState<Map<string, CodingChangeView[]> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    if (edits !== null || loading) return;
    setLoading(true);
    setError(null);
    void getRunFileChangesAction({ jobId })
      .then((res) => {
        if (res.ok) setEdits(new Map(res.data.map((g) => [g.filePath, g.edits])));
        else setError(res.code);
      })
      .catch(() => setError('unreachable'))
      .finally(() => setLoading(false));
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid="delivery-files">
      {files.map((f) => (
        <FileChangeBlock
          key={f.path}
          defaultOpen={false}
          onOpen={load}
          pending={loading}
          // UNE ABSENCE NE S'AFFIRME PAS QUAND ELLE N'A PAS ÉTÉ CONSTATÉE
          // (invariant #4) : un chargement qui échoue le dit, il ne laisse pas
          // la plaque annoncer « aucun texte enregistré ».
          emptyNote={error !== null ? `No diff: ${error}` : undefined}
          group={{
            filePath: f.path,
            addedLines: f.addedLines,
            removedLines: f.removedLines,
            // Le mot du geste voyage avec l'en-tête : sans lui, la plaque le
            // déduirait de fragments qui ne sont pas encore là, et un fichier
            // créé se lirait « modified » jusqu'au dépli.
            changeKind: f.changeKind,
            edits: edits?.get(f.path) ?? AUCUN,
          }}
        />
      ))}
    </div>
  );
}
