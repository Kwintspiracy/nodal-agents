// DeliveryBlock — LA CONCLUSION DU TRAVAIL (P2bis, redessiné par #135).
//
// Il remplace `ProducedCard` ET la section de preuve du bas de page : ce qui a
// été livré, ce que ça a coûté, qui l'a relu et ce qui l'a éprouvé se lisent
// au même endroit, à la fin du travail qui les a produits — pas trois écrans
// plus bas, séparés de leur contexte.
//
// #135 a changé ce qu'il DIT, pas ce qu'il compte. Le titre est le mot du
// résultat — « Delivered », pas « Delivery summary », qui nommait un encart et
// non un fait. Les fichiers ne sont plus un nombre seul : ils sont nommés, un
// par ligne. Les contrôles s'appellent « Proof ». Et le pied mène au run.
//
// CE QUI N'EST PAS LÀ, ET POURQUOI. La maquette de Quentin montre six
// cellules : Fichiers, Lignes, Tests, Couverture, Durée, Coût. Cinq ont une
// source — « Lignes » se lit dans l'ENTRÉE des appels d'écriture, la même
// lecture que la page Code (`coding-changes.ts`), et c'est du churn : « +27
// −2 » veut dire vingt-sept lignes écrites et deux remplacées, pas le résultat
// d'une comparaison. « Couverture » demanderait un rapport de couverture que
// rien n'écrit : la cellule n'existe pas, pas de tiret, pas de zéro, pas de
// « n/a » (invariant #4). De même, une section vide ne se dessine pas.
//
// La maquette écrit aussi « 3 passed » après une commande de preuve.
// `ThreadProofRun` ne porte qu'un VERDICT par commande, jamais un compte de
// cas : ces nombres ne sont donc pas écrits. Les inventer ferait dire au
// produit ce que la base ne sait pas.
//
// « DELIVERED TOUJOURS, ET LE VERDICT À CÔTÉ » (Quentin, 19/09 au soir, devant
// le bloc sur la stack). Une première version remplaçait le mot par « Changes
// requested » quand la relecture demandait des corrections. C'était faux : un
// run relu a bel et bien livré quelque chose, et effacer « Delivered » revenait
// à dire que le travail n'avait pas eu lieu. Le bloc dit donc toujours ce qui
// s'est passé, et ce que la relecture en pense est un SECOND fait, posé à côté.

import Link from 'next/link';
import {
  ArrowSquareOut,
  Check,
  CheckCircle,
  PencilSimple,
  Terminal,
  Warning,
  X,
} from '@phosphor-icons/react/dist/ssr';
import AgentAvatar from '@/components/ui/AgentAvatar';
import StatusPill from '@/components/ui/StatusPill';
import type { DeliverySummary } from '@/lib/conversation-feed.ts';
import { formatCost, formatMs, shortToolName } from './format.ts';

/** Au-delà, la liste de fichiers cesse d'être lisible : on compte le reste. */
const FILES_SHOWN = 12;

/**
 * Au-delà, la liste de commandes cesse d'être lisible — même règle que les
 * fichiers, et pour la même raison (Reviewer C, passe 1 de la PR #327).
 *
 * `classifyProduction` pousse un item par ligne `terminal` réussie, sans
 * plafond : une session de code qui lance cent cinquante appels shell rendait
 * un encart de cent cinquante lignes, plus long que le fil qu'il conclut. Le
 * modèle les porte toutes, comme pour les fichiers ; l'écran en montre douze
 * et COMPTE le reste, il ne le jette pas.
 */
const COMMANDS_SHOWN = 12;

/**
 * Le mot que la relecture ajoute à côté de « Delivered » (#59). `null` quand
 * personne n'a relu : le bloc n'a alors qu'un fait à dire.
 *
 * La base ne porte qu'un code (`approve`, `request_changes`) ; les mots vivent
 * ici, comme tout le texte de cet écran (invariant #2). Un code inconnu
 * s'affiche TEL QUEL — une relecture qu'on ne sait pas nommer a quand même eu
 * lieu, et la taire serait pire que la nommer mal (invariant #4).
 */
const REVIEW_WORDS: Record<string, string> = {
  approve: 'Approved',
  request_changes: 'Changes requested',
};

function reviewWord(review: string | null): string | null {
  if (review === null || review === '') return null;
  return REVIEW_WORDS[review] ?? review;
}

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="w-[100px] shrink-0">
      <p className="text-mono-11 text-ink-4">{label}</p>
      <p className={`mt-0.5 text-medium-14 ${mono ? 'text-feed-metric' : 'text-ink'}`}>{value}</p>
    </div>
  );
}

export default function DeliveryBlock({
  summary,
  jobId,
}: {
  summary: DeliverySummary;
  /**
   * Le travail que ce récapitulatif conclut — « Open run » y mène. `null`
   * quand l'appelant n'en a pas : le lien ne se dessine alors pas, plutôt que
   * de pointer vers une page introuvable.
   */
  jobId: string | null;
}) {
  const { verdict, changesRequested } = summary;
  // Le mot de la relecture, ou `null` quand personne n'a relu. Il ne remplace
  // jamais « Delivered », il s'ajoute — et une valeur que cet écran ne connaît
  // pas s'affiche telle quelle plutôt que de disparaître (invariant #4).
  const reviewLabel = reviewWord(summary.review);
  const stats: Array<{ label: string; value: string; mono?: boolean }> = [];
  if (summary.files > 0) stats.push({ label: 'Files', value: String(summary.files) });
  if (summary.lines !== null) {
    // L'ordre de la maquette : les fichiers, puis ce qu'ils ont pris de lignes.
    stats.push({
      label: 'Lines',
      value: [
        summary.lines.added > 0 ? `+${summary.lines.added}` : null,
        summary.lines.removed > 0 ? `−${summary.lines.removed}` : null,
      ]
        .filter((x): x is string => x !== null)
        .join(' '),
    });
  }
  if (summary.tests !== null) {
    stats.push({ label: 'Tests', value: `${summary.tests.passed} / ${summary.tests.total}` });
  }
  if (summary.durationMs !== null && summary.durationMs > 0) {
    // La durée est une MESURE : elle porte la couleur des mesures du fil.
    stats.push({ label: 'Duration', value: formatMs(summary.durationMs), mono: true });
  }
  if (summary.costUsd !== null) {
    stats.push({ label: 'Cost', value: formatCost(summary.costUsd) });
  }

  const shownFiles = summary.filePaths.slice(0, FILES_SHOWN);
  const hiddenFiles = summary.filePaths.length - shownFiles.length;
  const shownCommands = summary.commands.slice(0, COMMANDS_SHOWN);
  const hiddenCommands = summary.commands.length - shownCommands.length;
  // Le pied ne se dessine que s'il a quelque chose à dire : personne n'a relu
  // ET aucun run à ouvrir, il n'y a pas de pied.
  const showFoot = summary.reviews.length > 0 || jobId !== null;

  // Pleine largeur, comme tout bloc du fil (#135) : la marge de 46 px poussait
  // le récapitulatif vers la droite, plus étroit que les blocs du travail
  // qu'il conclut.
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-rule-2 bg-paper">
      <div className="flex h-[48px] items-center gap-2.5 px-4">
        {/* L'icône dit LIVRÉ, la pastille dit vérifié ou non — deux faits, deux
            signes (Quentin, 18/09). Elle est donc verte dès que ce bloc
            paraît : un run livré sans preuve n'est pas un demi-run, et un
            crochet gris le faisait passer pour éteint. Seul un verdict ROUGE
            la fait virer : là, quelque chose ne va pas.

            Une relecture qui demande des corrections fait le même effet sur le
            signe, et sur lui seul : le mot, lui, ne bouge plus (#59, décision
            du 19/09 au soir). */}
        {/* UNE ABSENCE SE DESSINE EN GRIS, jamais en rouge (#282) : un tour
            dont la seule commande n'a rien laissé voir n'est pas en panne, il
            est indéterminé. Le crochet reste, sa couleur s'éteint. */}
        {changesRequested ? (
          <Warning size={16} className="text-warn" aria-hidden />
        ) : (
          <CheckCircle
            size={16}
            className={
              !summary.produced ? 'text-ink-4' : verdict === 'red' ? 'text-warn' : 'text-ok'
            }
            aria-hidden
          />
        )}
        {/* Le mot du résultat, puis ce que la relecture en dit — deux faits,
            jamais l'un à la place de l'autre. Sans relecture, il n'y a qu'un
            fait et la ligne s'arrête là. */}
        {/* « DELIVERED » SE MÉRITE (#282). L'encart paraît désormais aussi pour
            un tour dont la seule commande n'a rien laissé voir ; écrire
            « Delivered » au-dessus de cette liste dirait le contraire de ce que
            le verdict a mesuré. Le mot devient alors « Ran » : quelque chose a
            bien tourné, et c'est tout ce qu'on sait. */}
        <span className="text-title-15 text-ink">
          {summary.produced ? 'Delivered' : 'Ran'}
          {reviewLabel !== null && <span className="text-ink-3"> · {reviewLabel}</span>}
        </span>
        {/* La pastille suit le mot, à trente pixels — pas poussée au bord
            droit : c'est ainsi que la planche la dessine (Quentin, 17/09,
            « design légèrement différent »).

            Quand quelqu'un a relu, elle NOMME qui a tranché ; c'est alors le
            fait le plus frais du bloc. Les commandes de preuve gardent leur
            sort une ligne plus bas, dans « Proof ». */}
        <span className="ml-5">
          {reviewLabel !== null ? (
            <StatusPill variant={changesRequested ? 'warn' : 'done'} label="By the reviewer" />
          ) : verdict === 'green' ? (
            <StatusPill variant="done" label="Verified" />
          ) : verdict === 'red' ? (
            <StatusPill variant="warn" label="Checks failed" />
          ) : (
            <StatusPill variant="idle" label="Not verified" />
          )}
        </span>
      </div>

      {stats.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-3 border-t border-rule-2 px-4 py-3">
          {stats.map((s) => (
            <Stat key={s.label} label={s.label} value={s.value} mono={s.mono ?? false} />
          ))}
        </div>
      )}

      {shownFiles.length > 0 && (
        <div className="border-t border-rule-2 px-4 py-2.5">
          <ul className="flex flex-col gap-1">
            {shownFiles.map((path) => (
              <li key={path} className="flex min-w-0 items-center gap-2">
                <PencilSimple size={12} className="shrink-0 text-ink-4" aria-hidden />
                <span className="min-w-0 truncate text-mono-12 text-feed-path">{path}</span>
              </li>
            ))}
          </ul>
          {hiddenFiles > 0 && (
            <p className="mt-1 text-mono-11 text-ink-4">… and {hiddenFiles} more</p>
          )}
        </div>
      )}

      {/* LES COMMANDES DU TRAVAIL, et ce qu'on a vu de chacune (#282). Une
          commande dont aucune écriture n'a été constatée sur son tour le DIT,
          au lieu de disparaître de l'écran : c'est l'absence que le verdict a
          mesurée, et l'invariant #4 demande qu'elle se dise.

          « nothing observed », et pas « rien fait » : dans un dépôt, le constat
          par git aurait vu l'écriture. Ce qui manque est le CONSTAT, pas
          forcément l'effet. */}
      {summary.commands.length > 0 && (
        <div className="border-t border-rule-2 px-4 pt-2.5 pb-3">
          <p className="mb-1 text-mono-11 text-ink-4">Commands</p>
          <ul className="flex flex-col gap-1">
            {shownCommands.map((c, i) => (
              <li
                key={i}
                className="flex min-w-0 items-center gap-2"
                data-testid="delivery-command"
              >
                <Terminal size={12} className="shrink-0 text-ink-4" aria-hidden />
                <span className="min-w-0 truncate text-mono-12 text-ink-2">{c.label}</span>
                {!c.observed && (
                  <span className="shrink-0 text-mono-11 text-ink-4">nothing observed</span>
                )}
              </li>
            ))}
          </ul>
          {hiddenCommands > 0 && (
            <p className="mt-1 text-mono-11 text-ink-4">… and {hiddenCommands} more</p>
          )}
        </div>
      )}

      {summary.checks.length > 0 && (
        <div className="border-t border-rule-2 px-4 pt-2.5 pb-3">
          <p className="mb-1 text-mono-11 text-ink-4">Proof</p>
          <ul className="flex flex-col gap-1">
            {summary.checks.map((c, i) => (
              <li key={i} className="flex min-w-0 items-center gap-2">
                {c.ok ? (
                  <Check size={12} className="shrink-0 text-ok" aria-hidden />
                ) : (
                  <X size={12} className="shrink-0 text-warn" aria-hidden />
                )}
                <span className="min-w-0 truncate text-mono-12 text-ink-2">{c.command}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showFoot && (
        <div className="flex flex-wrap items-center gap-2.5 border-t border-rule-2 px-4 pt-2.5 pb-3">
          {summary.reviews.length > 0 && (
            <span className="text-mono-11 text-ink-4">Reviewed by</span>
          )}
          {summary.reviews.map((r, i) => (
            <span key={i} className="flex items-center gap-2">
              {r.isAgent && (
                <AgentAvatar name={r.name} imageUrl={r.avatarUrl} size="sm" shape="square" />
              )}
              {/* Le nom seul, comme la planche : un refus de relecture se lit
                  dans le fil, sur le bloc de la délégation, pas ici. Le point
                  de couleur que le code portait n'est pas dessiné. */}
              <span
                className={`text-medium-13 ${r.ok ? 'text-ink' : 'text-warn'}`}
                title={r.ok ? undefined : 'This review said no'}
              >
                {r.isAgent ? r.name : shortToolName(r.name)}
              </span>
            </span>
          ))}
          {jobId !== null && (
            // Après le dernier nom, à trente pixels — pas au bord droit : la
            // planche le pose dans la ligne, comme la pastille du haut.
            <Link
              href={`/scheduled/${jobId}`}
              className="ml-5 flex shrink-0 items-center gap-1.5 text-medium-13 text-ink-2 transition-colors hover:text-ink"
            >
              Open run
              <ArrowSquareOut size={12} className="text-ink-3" aria-hidden />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
