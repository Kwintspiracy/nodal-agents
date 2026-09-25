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
import DeliveryMedia from './DeliveryMedia.tsx';
import { mediaTypeOfPath } from '@/lib/media-kinds.ts';
import { getRunFileChangesAction } from '@/lib/run-file-changes-actions.ts';
import type { CodingChangeView } from '@/lib/coding-changes.ts';
import type { DeliveryFileChange } from '@/lib/conversation-feed.ts';
import type { FileChangeGroup } from '@/lib/file-change-groups.ts';

/** Une plaque sans fragment garde la MÊME liste vide d'un rendu à l'autre. */
const AUCUN: CodingChangeView[] = [];

export default function DeliveryFiles({
  files,
  jobId,
}: {
  files: DeliveryFileChange[];
  jobId: string;
}) {
  const [groupes, setGroupes] = useState<FileChangeGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    if (groupes !== null || loading) return;
    setLoading(true);
    setError(null);
    void getRunFileChangesAction({ jobId })
      .then((res) => {
        if (res.ok) setGroupes(res.data);
        else setError(res.code);
      })
      .catch(() => setError('unreachable'))
      .finally(() => setLoading(false));
  };

  // DEUX FICHIERS PEUVENT PORTER LE MÊME CHEMIN AFFICHÉ (Reviewer C, #380).
  // Leur identité est le chemin BRUT, qui ne sort jamais du serveur (#161) :
  // `cles/sk-A.txt` et `cles/sk-B.txt` sont deux fichiers et masquent vers le
  // même texte. Une `Map` par chemin en perdait un — le second écrasait le
  // premier, et les deux plaques montraient le même diff. Les fragments se
  // rejoignent donc par le RANG : le n-ième fichier d'un chemin prend le
  // n-ième groupe de ce chemin, et les deux listes sortent du même moteur,
  // dans le même ordre.
  const parChemin = new Map<string, CodingChangeView[][]>();
  for (const g of groupes ?? []) {
    const deja = parChemin.get(g.filePath) ?? [];
    deja.push(g.edits);
    parChemin.set(g.filePath, deja);
  }
  const rang = new Map<string, number>();

  return (
    // BORD À BORD, COLLÉES (Quentin, 22/09). Aucun écart entre les plaques et
    // aucune marge autour : elles s'empilent sous les cellules comme les
    // sections de l'encart, séparées par le filet que chacune porte.
    <div className="flex flex-col" data-testid="delivery-files">
      {files.map((f) => {
        const n = rang.get(f.path) ?? 0;
        rang.set(f.path, n + 1);
        // Une image, une piste, une vidéo : pas de diff à peindre, le média
        // lui-même à la place (#490).
        const media = mediaTypeOfPath(f.path);
        if (media !== null) {
          return (
            <DeliveryMedia
              key={`${f.path}#${n}`}
              file={f}
              kind={media.kind}
              jobId={jobId}
              rank={n}
            />
          );
        }
        return (
          <FileChangeBlock
            key={`${f.path}#${n}`}
            flush
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
              edits: parChemin.get(f.path)?.[n] ?? AUCUN,
            }}
          />
        );
      })}
    </div>
  );
}
