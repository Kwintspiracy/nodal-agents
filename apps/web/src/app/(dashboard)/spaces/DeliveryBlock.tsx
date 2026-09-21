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
// lecture que la page Code (`coding-changes.ts`), et c'est le DIFF de chaque
// écriture (#394) : « +27 −2 » veut dire que les plaques, dépliées, colorient
// vingt-sept rangées en vert et deux en rouge. « Couverture » demanderait un
// rapport de couverture que
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

import {
  ArrowSquareOut,
  Check,
  CheckCircle,
  CircleNotch,
  HourglassSimple,
  PencilSimple,
  Terminal,
  Warning,
  X,
} from '@phosphor-icons/react/dist/ssr';
import AgentAvatar from '@/components/ui/AgentAvatar';
import PrimaryButton from '@/components/ui/PrimaryButton';
import StatusPill from '@/components/ui/StatusPill';
import StopRunButton from '@/components/ui/StopRunButton';
import { canStopRun } from '@/lib/job-live.ts';
import DeliveryFiles from './DeliveryFiles.tsx';
import type { DeliveryCommand, DeliverySummary } from '@/lib/conversation-feed.ts';
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

/**
 * CE QUE LA LIGNE D'UNE COMMANDE DIT DE SON ISSUE (#395), ou `null` quand elle
 * n'a rien à dire.
 *
 * Une sortie à zéro ne se dit pas : c'est le cas courant, et le répéter sur
 * chaque ligne noierait celle qui a lâché. Un code inconnu (`exitCode: null`
 * sans délai dépassé) ne se dit pas non plus — inventer « exit 0 » là serait
 * un succès affirmé sans constat (invariant #4), et le dire « unknown » sur
 * toutes les lignes d'avant la carte `terminal` ferait du bruit pour rien.
 *
 * Exportée pour le test : la règle compte plus que le pixel, et elle se
 * vérifie cas par cas sans rendre l'encart entier.
 */
export function commandOutcome(command: DeliveryCommand): string | null {
  if (command.blocked) return 'blocked';
  if (command.timedOut) return 'timed out';
  if (command.exitCode === null || command.exitCode === 0) return null;
  return `exit ${String(command.exitCode)}`;
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
  status = null,
  filesJobId = null,
}: {
  summary: DeliverySummary;
  /**
   * Le travail que ce récapitulatif conclut — « Open run » y mène. `null`
   * quand l'appelant n'en a pas : le lien ne se dessine alors pas, plutôt que
   * de pointer vers une page introuvable.
   */
  jobId: string | null;
  /**
   * Le statut de ce travail (`agent_jobs.status`), pour le bouton Stop à côté
   * d'« Open run » : il ne se dessine que sur un statut vivant, et jamais
   * sans `jobId`. `null` quand l'appelant ne le connaît pas : pas de bouton.
   */
  status?: string | null;
  /**
   * Le travail dont les DIFFS se chargent au dépli (#369). Distinct de `jobId`,
   * qui n'est que la cible du lien « Open run » : la page d'un run se passe du
   * lien vers elle-même, et ses fichiers doivent pourtant s'ouvrir.
   *
   * `null` : les fichiers restent une liste de chemins. C'est le choix de la
   * page d'un run de code, où les mêmes plaques se dessinent déjà dans le
   * panneau Changes juste dessous.
   */
  filesJobId?: string | null;
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

  const shownFiles = summary.fileChanges.slice(0, FILES_SHOWN);
  const hiddenFiles = summary.fileChanges.length - shownFiles.length;
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
      <div className="flex h-[48px] items-center gap-2.5 px-4" data-testid="delivery-head">
        {/* TANT QUE ÇA TRAVAILLE, RIEN N'EST LIVRÉ (Quentin, 22/09 : « un panneau
            Delivered avec un crochet vert, un bouton Stop et Running en haut »).
            L'icône et le mot prennent la couleur de « Running », et le crochet
            attend la fin. */}
        {summary.live === 'working' ? (
          <CircleNotch size={16} className="animate-spin text-run" aria-hidden />
        ) : summary.live === 'waiting' ? (
          // Bloqué sur la personne (une approbation) : il n'y a rien qui tourne,
          // donc pas de spinner ; la couleur est celle du « needs approval » de
          // la page Code (Reviewer C, #337).
          <HourglassSimple size={16} className="text-warn" aria-hidden />
        ) : changesRequested ? (
          <Warning size={16} className="text-warn" aria-hidden />
        ) : null}
        {/* L'icône dit LIVRÉ, la pastille dit vérifié ou non — deux faits, deux
            signes (Quentin, 18/09). Elle est donc verte dès que ce bloc
            paraît : un run livré sans preuve n'est pas un demi-run, et un
            crochet gris le faisait passer pour éteint.

            Une relecture qui demande des corrections fait le même effet sur le
            signe, et sur lui seul : le mot, lui, ne bouge plus (#59, décision
            du 19/09 au soir). */}
        {/* UNE ABSENCE SE DESSINE EN GRIS, jamais en rouge (#282) : un tour
            dont la seule commande n'a rien laissé voir n'est pas en panne, il
            est indéterminé. Le crochet reste, sa couleur s'éteint. */}
        {/* ET LE CROCHET NE PORTE PLUS LE VERDICT DE PREUVE (#373, Quentin le
            21/09 devant un run relu : « ça veut dire quoi car à côté ça dit
            Approved, donc ça a été livré ou pas ? et pourquoi c'est rouge ? »).
            Il virait au warn dès qu'une commande de preuve avait lâché, à
            côté du mot « Approved » : trois faits, deux dits en toutes lettres
            et le troisième caché dans la couleur d'un signe, ce qui se lisait
            comme une contradiction. Le verdict de preuve est devenu un MOT,
            une ligne plus loin. Le crochet ne dit plus qu'une chose : le run a
            livré, ou il n'est pas allé au bout. */}
        {summary.live !== null || changesRequested ? null : (
          <CheckCircle
            size={16}
            className={
              // Un run arrêté ou tombé n'a pas de crochet vert, quoi qu'il
              // ait écrit : le signe dit l'issue du travail, pas sa trace.
              summary.ended !== null || !summary.produced ? 'text-ink-4' : 'text-ok'
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
        {/* ET IL NE SE DIT PAS D'UN RUN QUI N'EST PAS ALLÉ AU BOUT (Quentin,
            22/09 : un run annulé « apparaît comme delivered »). Ce qu'il a
            écrit avant reste listé dessous ; l'en-tête dit l'issue. */}
        {/* TROIS MOTS TIENNENT SUR LA LIGNE, OU ELLE COUPE (Reviewer C, #373) :
            l'en-tête a une hauteur fixe de 48 px, et rien n'y bornait la suite
            de mots. Avec un troisième, une largeur étroite la faisait pousser
            la pastille et le bouton Stop hors de la boîte. */}
        <span
          className={`min-w-0 truncate text-title-15 ${summary.live === 'working' ? 'text-run' : summary.live === 'waiting' ? 'text-warn' : 'text-ink'}`}
        >
          {summary.live === 'working'
            ? 'Working'
            : summary.live === 'waiting'
              ? 'Waiting for you'
              : summary.ended === 'stopped'
                ? 'Stopped'
                : summary.ended === 'failed'
                  ? 'Failed'
                  : summary.produced
                    ? 'Delivered'
                    : 'Ran'}
          {reviewLabel !== null && <span className="text-ink-3"> · {reviewLabel}</span>}
          {/* LE TROISIÈME FAIT, DIT (#373) : ce que les commandes de preuve ont
              répondu. Il suit la même grammaire que les deux autres — un mot,
              sur la même ligne, séparé d'un point médian — et porte sa couleur
              plutôt que de la prêter au crochet.

              Rien quand aucune preuve n'a été déclarée : il n'y a alors pas de
              troisième fait, et un mot gris en inventerait un.

              Et rien tant que le run court : les preuves qui ont déjà tourné
              se comptent dans la pastille, elles ne concluent pas (même règle
              que « Verified », Quentin le 22/09).

              IL REDIT LA PASTILLE QUAND PERSONNE N'A RELU, et c'est assumé
              (Reviewer C, #373) : la pastille dit alors « Verified » ou
              « Checks failed », le mot dit la même chose. Dès qu'une relecture
              existe — le cas de l'issue — la pastille nomme le relecteur et le
              mot devient le seul endroit où le sort des preuves se lit. Taire
              le mot dans l'autre cas ferait dépendre la grammaire de la ligne
              d'un fait qui n'a rien à voir avec elle. */}
          {/* ET IL DIT CE QUE LE VERDICT A COÛTÉ (#375) : depuis qu'une preuve
              rouge rouvre le run pour un tour de réparation, « Proof passed »
              tout court cacherait qu'il a fallu s'y reprendre. Rien à zéro
              réparation — le cas ordinaire — ni quand la surface n'a pas lu la
              colonne : une absence ne s'écrit pas. */}
          {summary.live === null && verdict !== null && (
            <span className={verdict === 'red' ? 'text-warn' : 'text-ok'}>
              {' '}
              · {verdict === 'red' ? 'Proof failed' : 'Proof passed'}
              {summary.repairs !== null && summary.repairs > 0
                ? ` after ${summary.repairs} repair${summary.repairs > 1 ? 's' : ''}`
                : ''}
            </span>
          )}
        </span>
        {/* La pastille suit le mot, à trente pixels — pas poussée au bord
            droit : c'est ainsi que la planche la dessine (Quentin, 17/09,
            « design légèrement différent »).

            Quand quelqu'un a relu, elle NOMME qui a tranché ; c'est alors le
            fait le plus frais du bloc. Les commandes de preuve gardent leur
            sort une ligne plus bas, dans « Proof ».

            ET ELLE NE SUIT PAS LE MOT DE L'EN-TÊTE (Reviewer C, #335) : un run
            arrêté dont les preuves ont tourné vertes lit « Stopped · Verified ».
            Deux faits, deux signes : l'issue du travail, et ce que les preuves
            ont dit. Masquer « Verified » dirait que les preuves n'ont pas eu
            lieu, ce qui serait faux. */}
        {/* TANT QUE ÇA COURT, RIEN N'EST « VERIFIED » (Quentin, 22/09 : « comment
            le contenu qui est en Working peut être verified ? »). Les preuves
            qui ont déjà tourné se COMPTENT, elles ne concluent pas : la
            conclusion attend la fin du run. */}
        <span className="ml-5">
          {reviewLabel !== null ? (
            <StatusPill variant={changesRequested ? 'warn' : 'done'} label="By the reviewer" />
          ) : summary.live !== null ? (
            <StatusPill
              variant="idle"
              label={
                // Sans dénominateur (Reviewer C, #342) : « 1 / 1 » se lirait
                // comme un état final alors qu'une preuve peut encore courir.
                summary.tests !== null
                  ? `${summary.tests.passed} ${summary.tests.passed === 1 ? 'check' : 'checks'} passed so far`
                  : 'No checks yet'
              }
            />
          ) : verdict === 'green' ? (
            <StatusPill variant="done" label="Verified" />
          ) : verdict === 'red' ? (
            <StatusPill variant="warn" label="Checks failed" />
          ) : (
            <StatusPill variant="idle" label="Not verified" />
          )}
        </span>
        {/* ARRÊTER LE RUN D'ICI, tant qu'il court (Quentin, 22/09). EN HAUT de
            la boîte et à droite, seul sur son bord : mêlé au pied, entre les
            relecteurs et « Open run », il se perdait dans le contenu. Il se
            cache tout seul dès que le run n'est plus vivant, et jamais sans
            `jobId`. */}
        {jobId !== null && canStopRun(status) && (
          <span className="ml-auto">
            <StopRunButton jobId={jobId} status={status} />
          </span>
        )}
      </div>

      {stats.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-3 border-t border-rule-2 px-4 py-3">
          {stats.map((s) => (
            <Stat key={s.label} label={s.label} value={s.value} mono={s.mono ?? false} />
          ))}
        </div>
      )}

      {/* CE QUI A CHANGÉ DANS CHAQUE FICHIER (#369). Une plaque par fichier,
          REPLIÉE : la ligne porte le chemin et « +N −M », le clic montre le
          diff unifié — la même plaque que la page d'un run, au même moteur.

          Sans `filesJobId`, la liste reste des chemins nus. C'est le cas de la
          page d'un run de code, qui dessine ces mêmes plaques dans son panneau
          Changes quelques pixels plus bas : les tracer deux fois sur un écran
          n'apprendrait rien à personne. */}
      {shownFiles.length > 0 && (
        <div className="border-t border-rule-2 px-4 py-2.5">
          {filesJobId !== null ? (
            <DeliveryFiles files={shownFiles} jobId={filesJobId} />
          ) : (
            <ul className="flex flex-col gap-1">
              {shownFiles.map((f) => (
                <li key={f.path} className="flex min-w-0 items-center gap-2">
                  <PencilSimple size={12} className="shrink-0 text-ink-4" aria-hidden />
                  <span className="min-w-0 truncate text-mono-12 text-feed-path">{f.path}</span>
                </li>
              ))}
            </ul>
          )}
          {hiddenFiles > 0 && (
            <p className="mt-1 text-mono-11 text-ink-4">… and {hiddenFiles} more</p>
          )}
        </div>
      )}

      {/* LES COMMANDES DU TRAVAIL, et ce qu'on a vu de chacune (#282). Une
          commande dont aucune écriture n'a été constatée sur son tour le DIT,
          au lieu de disparaître de l'écran : c'est l'absence que le verdict a
          mesurée, et l'invariant #4 demande qu'elle se dise.

          « no file change seen », et pas « rien fait » : dans un dépôt, le
          constat par git aurait vu l'écriture. Ce qui manque est le CONSTAT,
          pas forcément l'effet. (« nothing observed » jusqu'au 22/09 : Quentin
          ne savait pas ce que ça voulait dire ; le mot dit maintenant CE qui
          n'a pas été vu.) */}
      {summary.commands.length > 0 && (
        <div className="border-t border-rule-2 px-4 pt-2.5 pb-3">
          <p className="text-mono-11 text-ink-4">Commands</p>
          {/* CE QUE CETTE LISTE EST, ET CE QU'ELLE N'EST PAS (#395). Quentin,
              21/09 : « est-ce que ce sont seulement les commandes de test, dont
              le résultat est dans Proof ? ». Non — c'est tout ce que le run a
              lancé, et « Proof » juste dessous est une autre chose. La phrase
              le dit une fois, sous le titre, plutôt que de laisser deux listes
              voisines se confondre. */}
          <p className="mb-1.5 text-body-12 text-ink-4">
            Every command the run executed. Proof below lists the checks the agent declared.
          </p>
          <ul className="flex flex-col gap-1">
            {shownCommands.map((c, i) => (
              <li key={i} className="flex min-w-0 items-start gap-2" data-testid="delivery-command">
                <Terminal size={12} className="mt-1 shrink-0 text-ink-4" aria-hidden />
                <div className="flex min-w-0 flex-1 flex-col">
                  {/* POURQUOI, PUIS QUOI (#372). La liste ne disait que la
                      ligne de commande ; « ça serait bien d'avoir une
                      information qui dit pourquoi la commande est exécutée »
                      (Quentin, 21/09). L'agent l'a déjà écrite dans l'entrée
                      de l'appel : elle est posée telle quelle, dans sa voix.
                      Sans elle, la commande reste seule — le produit n'en
                      compose aucune (invariant #2). */}
                  {/* DEUX LIGNES AU PLUS (Reviewer C, #372). Le schéma de
                      `run_command` accepte quatre cents caractères : une
                      phrase de cette taille pousserait à elle seule l'encart
                      plus bas que le travail qu'il conclut. Elle n'est pas
                      jetée pour autant, elle est repliée. */}
                  {c.purpose !== null && (
                    <span
                      data-testid="delivery-command-purpose"
                      className="line-clamp-2 text-body-12 text-ink-2"
                    >
                      {c.purpose}
                    </span>
                  )}
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-mono-12 text-ink-2">{c.label}</span>
                    {/* L'ISSUE DE LA COMMANDE (#395). Une sortie à zéro ne dit
                        rien : c'est le cas courant, et l'écrire sur chaque
                        ligne noierait celle qui a lâché. Tout le reste se dit
                        en un mot, dans la couleur de l'attention. */}
                    {commandOutcome(c) !== null && (
                      <span
                        data-testid="delivery-command-outcome"
                        className="shrink-0 text-mono-11 text-warn"
                      >
                        {commandOutcome(c)}
                      </span>
                    )}
                    {!c.observed && (
                      <span className="shrink-0 text-mono-11 text-ink-4">no file change seen</span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {/* La MÊME phrase que sous les fichiers, quelques lignes plus haut :
              une étiquette la distingue, sinon un test qui la cherche ne dit
              pas de quelle liste il parle (Reviewer C, passe 2). */}
          {hiddenCommands > 0 && (
            <p data-testid="commands-more" className="mt-1 text-mono-11 text-ink-4">
              … and {hiddenCommands} more
            </p>
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
            // UN VRAI BOUTON, AU BORD DROIT (Quentin, 22/09) : il était un lien
            // posé après le dernier relecteur, à trente pixels, et se lisait
            // comme un nom de plus. Le même bouton neutre que « Files » dans la
            // barre, seul sur son bord, l'icône dit qu'il ouvre une page.
            <span className="ml-auto">
              <PrimaryButton variant="neutral" size="sm" href={`/scheduled/${jobId}`}>
                Open run
                <ArrowSquareOut size={12} aria-hidden />
              </PrimaryButton>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
