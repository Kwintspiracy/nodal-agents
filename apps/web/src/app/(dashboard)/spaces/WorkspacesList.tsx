'use client';

// WorkspacesList — UNE liste de projets, registre et détection confondus (#143).
//
// UNE LIGNE DIT QUATRE CHOSES, et pas une de plus (Quentin, 19/09) : la marque
// du dossier, le NOM du projet, son CHEMIN, la DATE où il est apparu, et sa
// PREUVE. Même géométrie que la boîte de réception d'un dossier de chat : un
// trait entre les lignes, une seule boîte.
//
// La planche (écran 444:210) en dessinait davantage : l'avatar de l'agent
// responsable, son nom, le compte de conversations et de sessions, la dernière
// activité. Tout cela est parti le 19/09, sur un constat de Quentin : on parle
// toujours au MÊME orchestrateur, donc son visage et son nom étaient la même
// colonne répétée sur toute la liste. Les comptes, eux, n'aidaient pas à
// RETROUVER un projet, qui est ce qu'on vient faire ici.
//
// (Le nom de cet orchestrateur ne s'écrit nulle part dans le source, pas même
// dans ce commentaire : invariant #1, et `architecture.test.ts` le vérifie.)
//
// Les dossiers DÉTECTÉS — ceux où un agent a écrit sans que personne les ait
// déclarés — sont dans la MÊME liste, marqués « Detected », avec les deux
// gestes que l'onglet Code portait :
//
//   REGISTER — les inscrit au registre, avec l'agent qui a écrit comme
//              responsable. Ils deviennent des projets ordinaires.
//   HIDE     — les retire de la liste. Le dossier n'est JAMAIS touché, et le
//              geste se défait depuis « Hidden (N) », en bas de page.
//
// « HIDDEN (N) », justement, est le SEUL endroit où l'on retrouve ce qu'on a
// retiré — détecté ou déclaré (#364). Un projet du registre masqué restait
// dans la liste avec une étiquette, ce qui défaisait le geste de la barre
// latérale ; il est maintenant là, avec « Show in list ».
//
// Et depuis #371, c'est aussi le SEUL endroit d'où un projet peut QUITTER
// Nodal : « Forget » supprime sa ligne de registre et ses préférences, garde
// l'historique des runs et des conversations, et ne touche pas au dossier. Il
// n'apparaît que sur un projet du REGISTRE déjà masqué — oublier reste à deux
// gestes, et un dossier détecté masqué n'a qu'une ligne de masquage, qu'on ne
// supprime pas sans le ramener dans la liste.
//
// RENOMMER reste sur un projet OUVERT : c'est un geste qu'on pose en regardant
// le projet, pas en balayant une liste de cinquante.
//
// Ce composant DESSINE et APPELLE les deux actions ; il ne décide rien. La
// fusion, les comptes et la pastille vivent dans `lib/workspaces.ts`, prouvés
// sans navigateur.

import { useId, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Folder } from '@phosphor-icons/react/dist/ssr';
import Disc from '@/components/ui/Disc';
import StatusPill from '@/components/ui/StatusPill';
import RowActionButton from '@/components/ui/RowActionButton';
import TextButton from '@/components/ui/TextButton';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import { truncate } from '@/lib/format-time';
// La MÊME langue d'heure que les boîtes de réception (`14:02`, `Mon`,
// `Sep 12`) : deux listes de la même application ne datent pas une ligne de
// deux façons.
import { conversationTimeLabel } from '@/app/(dashboard)/chat/conversation-rows.ts';
// Les deux actions sont importées de LEUR module, jamais réexportées par un
// troisième : un fichier 'use server' qui en réexporte un autre casse le
// repérage des actions de Next.
import { setCodeProjectHiddenAction } from '@/lib/actions.ts';
import { forgetCodeProjectAction, registerDetectedProjectAction } from '@/lib/project-actions.ts';
// La confirmation du produit, jamais `window.confirm` (invariant #10).
import ConfirmDialog from '@/components/ConfirmDialog';
import type { WorkspaceProof, WorkspaceRow, WorkspacesView } from '@/lib/workspaces.ts';

/** La pastille de preuve : quatre états, quatre mots. */
const PROOF: Record<WorkspaceProof, { variant: 'done' | 'warn' | 'idle'; label: string }> = {
  verified: { variant: 'done', label: 'Verified' },
  failed: { variant: 'warn', label: 'Failed' },
  approval_pending: { variant: 'warn', label: 'Approval pending' },
  unverified: { variant: 'idle', label: 'Unverified' },
};

/** Hauteur, gouttière et marges de la planche — identiques avec ou sans lien. */
const ROW = 'flex min-h-14 items-center gap-3.5 px-4 py-2';

function RowBody({ row }: { row: WorkspaceRow }) {
  const proof = row.proof === null ? null : PROOF[row.proof];
  return (
    <>
      {/* UN DOSSIER, pas un visage (Quentin, 19/09). La ligne portait l'avatar
          de l'agent responsable ; il est systématiquement l'orchestrateur, donc
          le même sur toutes les lignes — une colonne qui n'apprend rien. Ce
          que la ligne EST, c'est un dossier, et la marque le dit.
          `Disc` est la primitive du DS pour une icône dans une case : même
          géométrie et même fond que l'avatar carré qu'elle remplace. */}
      <Disc variant="neutral" size="sm" shape="square">
        {/* DÉCORATIVE : le nom du projet est juste à côté, et un lecteur
            d'écran qui annoncerait « dossier » avant chaque ligne d'une liste de
            dossiers ne dirait rien de plus. */}
        <Folder weight="fill" aria-hidden />
      </Disc>
      {/* min-w-0 : sans lui, un chemin long refuse de se couper et pousse
          l'heure et la pastille hors de la ligne. */}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* Pas d'étiquette « hidden » sur la ligne (#364) : une ligne masquée
            n'apparaît plus QUE sous « Hidden (N) », et répéter le mot sous le
            titre qui vient de le dire n'apprend rien. */}
        <span className="flex items-center gap-2">
          {row.kind === 'detected' && (
            <MonoMicroTag tone="ink" className="shrink-0">
              Detected
            </MonoMicroTag>
          )}
          <span className="truncate text-medium-14 text-ink">{truncate(row.name, 60)}</span>
          {/* Un projet de DOCUMENTS se dit : il n'exécute pas de commande, et
              sa pastille de preuve ne veut pas dire la même chose. Le code est
              le cas ordinaire et n'a pas besoin d'étiquette. */}
          {row.produces === 'documents' && (
            <MonoMicroTag tone="ink" className="shrink-0">
              documents
            </MonoMicroTag>
          )}
        </span>
        {/* LE CHEMIN, et rien d'autre (Quentin, 19/09). La sous-ligne comptait
            les conversations, les sessions et la dernière activité, et nommait
            l'agent responsable ; rien de tout cela n'aide à retrouver un
            projet dans une liste.
            RENDU ENTIER, coupé par le CSS à la largeur qu'il a (revue Reviewer
            C, passe 4). Il passait d'abord par un compteur de 44 signes, qui
            décidait d'une coupe sans connaître la largeur : sur un écran large
            il raccourcissait pour rien, sur un étroit le CSS recoupait par
            dessus — deux coupes pour une. L'infobulle porte la même valeur,
            entière elle aussi. */}
        <span className="truncate text-mono-12 text-ink-3" title={row.path}>
          {row.path}
        </span>
      </span>
      {/* LA DATE : au registre pour un projet, première écriture vue pour un
          dossier détecté. `null` quand rien ne la donne — la colonne reste
          VIDE plutôt que de porter un tiret qu'on lirait comme une valeur. */}
      {conversationTimeLabel(row.createdAt) !== null && (
        <span className="shrink-0 text-mono-11 text-ink-4" title={row.createdAt?.toISOString()}>
          {conversationTimeLabel(row.createdAt)}
        </span>
      )}
      {proof !== null && (
        <StatusPill variant={proof.variant} label={proof.label} className="shrink-0" />
      )}
    </>
  );
}

function DetectedActions({ row, onDone }: { row: WorkspaceRow; onDone: () => void }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  function run(call: () => Promise<{ ok: boolean; message?: string }>) {
    start(async () => {
      const result = await call();
      if (!result.ok) {
        // Un échec est DIT, et rien ne bouge : rafraîchir sur un refus
        // redessinerait la même ligne en laissant croire à un geste appliqué.
        toast.error(result.message ?? 'The action failed');
        return;
      }
      onDone();
      router.refresh();
    });
  }

  return (
    <span className="flex shrink-0 items-center gap-2 pr-4">
      <RowActionButton
        disabled={pending}
        onClick={() =>
          run(() => registerDetectedProjectAction({ projectPath: row.path, agentId: null }))
        }
        title="Keep this folder as a project, with the agent that wrote in it."
      >
        Register
      </RowActionButton>
      <RowActionButton
        disabled={pending}
        onClick={() =>
          run(() => setCodeProjectHiddenAction({ projectPath: row.path, hidden: true }))
        }
        title="Hides it here and for your agents. The folder is untouched."
      >
        Hide
      </RowActionButton>
    </span>
  );
}

/**
 * LE GESTE QUI DÉFAIT (#364) : une ligne masquée revient dans la liste.
 *
 * Le MÊME bouton pour un projet du registre et pour un dossier détecté, parce
 * que c'est le même geste et la même colonne en base (`code_projects.hidden`) :
 * deux libellés pour un seul geste feraient croire à deux effets.
 */
function ShowInListButton({ row, onDone }: { row: WorkspaceRow; onDone: () => void }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <>
      <RowActionButton
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await setCodeProjectHiddenAction({
              projectPath: row.path,
              hidden: false,
            });
            if (!result.ok) {
              toast.error(result.message ?? 'The action failed');
              return;
            }
            onDone();
            router.refresh();
          })
        }
        title="Put it back in the list and in the sidebar."
      >
        Show in list
      </RowActionButton>
    </>
  );
}

/**
 * LE GESTE QUI EFFACE (#371) : le projet quitte Nodal, son dossier reste.
 *
 * Il n'est offert QUE sous « Hidden (N) », et QUE sur un projet du registre.
 * Deux raisons, et ce sont les deux moitiés de la même :
 *
 *   — cacher d'abord, oublier ensuite. Le geste est irréversible (le nom
 *     choisi, la séquence de preuve et son approbation partent avec la ligne),
 *     donc il n'est jamais à un clic d'une liste qu'on balaie. L'action serveur
 *     tient la même règle : elle refuse un projet qui n'est pas masqué.
 *   — un dossier DÉTECTÉ caché n'a d'autre existence en base que ce masquage :
 *     supprimer sa ligne le ramènerait dans la liste. Il garde donc son seul
 *     geste, « Show in list ».
 *
 * La confirmation DIT les trois faits, parce qu'aucun d'eux ne se devine :
 * ce qui part, ce qui reste, et ce que Nodal ne touche pas.
 */
function ForgetButton({ row, onDone }: { row: WorkspaceRow; onDone: () => void }) {
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const router = useRouter();

  return (
    <>
      <RowActionButton
        tone="danger"
        disabled={pending}
        onClick={() => setAsking(true)}
        title="Delete this project from Nodal. The folder stays on disk."
      >
        Forget
      </RowActionButton>
      <ConfirmDialog
        open={asking}
        title={`Forget ${truncate(row.name, 40)}?`}
        message="The project leaves Nodal: its registration and its settings are deleted. Runs and conversations keep their history, with the link to the project cleared. Its folder on disk is not touched, deleting it is yours to do in your file explorer."
        confirmLabel="Forget"
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          start(async () => {
            const result = await forgetCodeProjectAction({ projectPath: row.path });
            if (!result.ok) {
              toast.error(result.message ?? 'The action failed');
              return;
            }
            onDone();
            router.refresh();
          });
        }}
      />
    </>
  );
}

function Row({ row, onDone }: { row: WorkspaceRow; onDone: () => void }) {
  // Les gestes de la ligne : une ligne masquée propose de revenir dans la
  // liste, et — si elle est au REGISTRE — de quitter Nodal pour de bon ; un
  // dossier détecté visible propose de s'inscrire ou de partir ; un projet du
  // registre visible n'en propose aucun ici, ses gestes sont sur sa page et
  // dans la barre latérale.
  const gestes = row.hidden ? (
    <span className="flex shrink-0 items-center gap-2 pr-4">
      <ShowInListButton row={row} onDone={onDone} />
      {row.kind === 'registered' && <ForgetButton row={row} onDone={onDone} />}
    </span>
  ) : row.kind === 'detected' ? (
    <DetectedActions row={row} onDone={onDone} />
  ) : null;

  // Un dossier détecté n'a PAS de page : il n'est pas au registre, donc il n'a
  // pas d'id. La ligne reste entière et ne feint pas un lien (invariant #4) ;
  // « Register » est justement le geste qui lui en donne un.
  const corps =
    row.kind === 'detected' ? (
      <div className={`${ROW} min-w-0 flex-1`}>
        <RowBody row={row} />
      </div>
    ) : (
      <Link href={`/spaces/${row.id}`} className={`${ROW} min-w-0 flex-1 hover:bg-hover`}>
        <RowBody row={row} />
      </Link>
    );

  if (gestes === null) {
    return (
      <Link
        href={`/spaces/${row.id}`}
        className={`${ROW} hover:bg-hover`}
        data-testid={`workspace-row-${row.key}`}
      >
        <RowBody row={row} />
      </Link>
    );
  }
  return (
    <div className="flex items-center" data-testid={`workspace-row-${row.key}`}>
      {corps}
      {gestes}
    </div>
  );
}

export default function WorkspacesList({ view }: { view: WorkspacesView }) {
  const [showHidden, setShowHidden] = useState(false);
  const hiddenCount = view.hiddenRows.length;
  const hiddenListId = useId();

  return (
    <div>
      {/* Pas d'écart entre les lignes : la planche les sépare d'un trait, dans
          une seule boîte. `overflow-hidden` fait suivre les coins arrondis à la
          première et à la dernière. */}
      <div className="divide-y divide-rule-2 overflow-hidden rounded-xl border border-rule-2 bg-paper">
        {view.rows.map((row) => (
          <Row key={row.key} row={row} onDone={() => setShowHidden(false)} />
        ))}
      </div>

      <p className="mt-3 text-body-12 text-ink-4">
        A row: the project, its folder, when it appeared, and its proof. Detected folders are
        projects Nodal found by itself; Register keeps them, Hide removes them from the list.
      </p>

      {/* UN SEUL contrôle pour ce qu'on a retiré, en bas de page, et ABSENT
          quand il n'y a rien à retrouver (#364) : « Hidden (0) » poserait une
          question à laquelle la page a déjà répondu. Replié, aucune ligne
          masquée n'est dans le DOM — un corps caché en CSS resterait
          cherchable. */}
      {hiddenCount > 0 && (
        <div className="mt-6">
          <TextButton
            className="text-medium-14 text-ink-2 underline underline-offset-2 hover:text-ink"
            aria-expanded={showHidden}
            aria-controls={hiddenListId}
            onClick={() => setShowHidden((v) => !v)}
            data-testid="hidden-projects-toggle"
          >
            {`Hidden (${hiddenCount})`}
          </TextButton>
          {showHidden && (
            <div id={hiddenListId}>
              {/* La phrase DIT ce que la section fait, et elle a changé avec
                  elle (#371) : « Nothing is deleted » était vrai tant que le
                  seul geste remettait dans la liste. Maintenant qu'on peut
                  oublier, ce qui reste vrai des DEUX gestes est que le dossier
                  n'est jamais touché. */}
              <p className="mb-2 mt-2 text-body-12 text-ink-4">
                Removed from the list and from the sidebar. Show in list puts a project back, Forget
                deletes it from Nodal. Either way the folders stay where they are on disk.
              </p>
              <div className="divide-y divide-rule-2 overflow-hidden rounded-xl border border-rule-2 bg-paper">
                {view.hiddenRows.map((row) => (
                  <Row key={row.key} row={row} onDone={() => setShowHidden(true)} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
