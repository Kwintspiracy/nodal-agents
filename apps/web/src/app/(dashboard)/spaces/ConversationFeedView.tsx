// ConversationFeedView — le fil dessiné (P2, plan « De la maquette au
// produit »). Rendu côté serveur depuis `ConversationFeed` ; dispatche sur la
// CARTE persistée par P1 (`presented.card`), jamais sur le nom de l'outil. Ce
// qu'il ne sait pas dessiner, il le montre brut et le dit.

import Link from 'next/link';
import { ArrowSquareOut, PaperPlaneTilt } from '@phosphor-icons/react/dist/ssr';
import AgentAvatar from '@/components/ui/AgentAvatar';
import StatusPill from '@/components/ui/StatusPill';
import StopRunButton from '@/components/ui/StopRunButton';
import { canStopRun } from '@/lib/job-live.ts';
import ClampedText from './ClampedText.tsx';
import Table, { THead, Th, Tr, Td } from '@/components/ui/Table';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import type { CardPayloadFor, TableEntry } from '@nodal-agents/shared';
import { readQuestionToolInput } from '@nodal-agents/shared';
import { deliverableStatusKey, type DeliverableStatusView } from '@/lib/verification-runs-view.ts';
import { findLineCounts, type LineCounts } from '@/lib/coding-changes.ts';
import { hintSentence } from '@/lib/failure-hint.ts';
import type {
  ConversationFeed,
  FeedChildJob,
  FeedItem,
  ReviewVerdictRecord,
  Step,
  TurnBlock,
} from '@/lib/conversation-feed.ts';
import Markdown, { plainText, plainLines } from '@/components/Markdown.tsx';
import { formatClock, truncate } from '@/lib/format-time';
import ThinkingBlock from './ThinkingBlock.tsx';
import ToolBlock from './ToolBlock.tsx';
import FoldableBlock, { FoldableBody } from './FoldableBlock.tsx';
import ModelCallBlock from './ModelCallBlock.tsx';
import DeliveryBlock from './DeliveryBlock.tsx';
import QuestionCard from './QuestionCard.tsx';
import FileDiff, { FileName, LineDelta } from './FileDiff.tsx';
// Les couleurs des pastilles viennent d'un module SANS directive (#240) : ce
// fichier est rendu côté serveur, qui ne reçoit d'un module `'use client'`
// qu'une référence par export, jamais la table elle-même.
import { DOT, FILE_DOT } from './feed-dots.ts';
import HistoryGroup from './HistoryGroup.tsx';
import DelegationDisclosure from './DelegationDisclosure.tsx';
import DelegationBlock from './DelegationBlock.tsx';
import Handoff from './Handoff.tsx';
import RunSummaryRow from './RunSummaryRow.tsx';
import { DEFAULT_FEED_DENSITY, type FeedDensity } from '@/lib/feed-density.ts';
import { formatCost, formatMs, formatTokens, originLabel } from './format.ts';

type ToolStep = Extract<Step, { kind: 'tool' }>;

/**
 * P12 — l'état de vérification des documents du fil, rangé par (job, clé
 * canonique) via `deliverableStatusKey` : la carte d'un classeur lit l'état
 * du job qui l'a écrit, pas celui d'un autre job du fil. Vide par défaut : un
 * appelant qui ne le passe pas obtient des cartes SANS ligne de vérification,
 * jamais une ligne inventée.
 */
type Deliverables = ReadonlyMap<string, string>;

export default function ConversationFeedView({
  feed,
  deliverables = [],
  density = DEFAULT_FEED_DENSITY,
  width = 'thread',
}: {
  feed: ConversationFeed;
  deliverables?: ReadonlyArray<DeliverableStatusView>;
  /**
   * #132 — l'état de DÉPART des groupes de run de la page, choisi par la
   * personne. Il n'enlève rien et n'ajoute rien : chaque groupe se déplie
   * ensuite pour son compte, et chaque bloc dedans aussi.
   */
  density?: FeedDensity;
  /**
   * La COLONNE dans laquelle le fil se dessine. `thread` (défaut) est la
   * colonne de lecture de 760 px, centrée, des trois écrans de fil. `full`
   * prend toute la largeur de son cadre : la page d'un run (18/09) est un
   * tableau de bord, ses cartes vont d'un bord à l'autre, et la chronologie
   * vit DANS l'une d'elles — une colonne centrée y laissait deux marges
   * blanches à l'intérieur d'une carte.
   */
  width?: 'thread' | 'full';
}) {
  if (feed.items.length === 0) {
    return <p className="text-body-13 text-ink-4">Nothing recorded yet.</p>;
  }
  const byKey: Deliverables = new Map(
    deliverables.map((d) => [deliverableStatusKey(d.jobId, d.canonicalKey), d.status]),
  );
  return (
    <div className={width === 'full' ? 'w-full min-w-0' : 'mx-auto max-w-[760px]'}>
      <FeedItems items={feed.items} deliverables={byKey} density={density} />
    </div>
  );
}

/**
 * Les items d'un fil, sans cadre : le fil de la page en haut, et le fil d'un
 * DÉLÉGUÉ sous sa carte de délégation (P2bis) passent par le même code.
 */
function FeedItems({
  items,
  deliverables,
  density = DEFAULT_FEED_DENSITY,
}: {
  items: FeedItem[];
  deliverables: Deliverables;
  density?: FeedDensity;
}) {
  // La réponse finale se rend comme un TOUR : il lui faut donc un nom et un
  // avatar. Le fil ne les porte pas sur l'item ; ils viennent du dernier tour
  // de l'agent, qui est celui qui l'a écrite — et depuis #132 ce tour peut
  // vivre DANS le groupe du run, d'où la descente.
  const lastTurn = [...items]
    .reverse()
    .flatMap((i) => (i.kind === 'run' ? [...i.items].reverse() : [i]))
    .find((i) => i.kind === 'turn');
  const agentName = lastTurn?.agent.name ?? 'Agent';
  const agentAvatarUrl = lastTurn?.agent.avatarUrl ?? null;
  return (
    <>
      {items.map((item, i) => (
        <FeedItemView
          key={i}
          item={item}
          deliverables={deliverables}
          agentName={agentName}
          agentAvatarUrl={agentAvatarUrl}
          density={density}
        />
      ))}
    </>
  );
}

function FeedItemView({
  item,
  deliverables,
  agentName,
  agentAvatarUrl,
  density = DEFAULT_FEED_DENSITY,
}: {
  item: FeedItem;
  deliverables: Deliverables;
  agentName: string;
  agentAvatarUrl: string | null;
  density?: FeedDensity;
}) {
  switch (item.kind) {
    case 'request':
      // La voix de l'utilisateur : à DROITE, dans une bulle teintée, bornée en
      // largeur — comme dans toute application de chat (Quentin, 07/09 : « tu
      // mets l'agent à gauche, l'humain à droite ; t'as déjà vu un chat ? »).
      // Pas d'icône : elle décalait le texte par rapport à la saisie du bas.
      return (
        <div className="flex justify-end pt-6">
          <div className="max-w-[80%] min-w-0">
            <p className="mb-1.5 text-right text-mono-11 text-ink-4">{originLabel(item.origin)}</p>
            <div className="rounded-xl bg-hover px-4 py-3">
              <ClampedText plain={item.text}>
                <Markdown text={item.text} tone="user" />
              </ClampedText>
            </div>
          </div>
        </div>
      );
    case 'note':
      // Le bruit système vit EN MARGE du fil : une ligne grise, tronquée,
      // alignée sur la colonne de texte. Un rappel du runner dit qui parle ; un
      // aveu du fil parle en son nom et n'a pas de préfixe.
      return (
        <p className="mt-3 truncate text-mono-11 text-ink-4" title={item.text}>
          {item.origin === 'runner' ? `Nodal reminded the agent · ${item.text}` : item.text}
        </p>
      );
    case 'turn': {
      // #135 — ce que le tour a demandé au modèle a désormais son BLOC, dans la
      // colonne de temps des appels d'outil (`ModelCallBlock`). L'en-tête ne
      // porte plus que le nom de l'agent et le modèle, et le bloc de
      // raisonnement ne porte plus que son compte d'étapes : ces nombres ne
      // vivaient nulle part en propre, ils vivaient à droite de ce qui passait
      // par là.
      //
      // Le tour ne DATE pas son appel de modèle : le bloc va donc en dernier,
      // après les blocs du tour, plutôt qu'à une place inventée.
      return (
        <Turn>
          <Who
            name={item.agent.name ?? 'Agent'}
            avatarUrl={item.agent.avatarUrl}
            model={item.model}
            at={item.at}
          />
          {item.blocks.map((b, i) => (
            <Block key={i} block={b} deliverables={deliverables} />
          ))}
          <ModelCallBlock model={item.model} usage={item.usage} className="mb-3" />
        </Turn>
      );
    }
    case 'run':
      // #135 / #132 — le travail du run, sous UNE ligne qui le résume. Replié
      // par défaut : la réponse est juste au-dessus, et c'est elle qu'on vient
      // lire. Déplié, ce sont EXACTEMENT les blocs de la page du run, rendus
      // par le même code — la densité ne change que l'état de départ.
      return (
        <RunSummaryRow
          jobId={item.jobId}
          summary={item.summary}
          defaultOpen={density === 'unfolded'}
        >
          <FeedItems items={item.items} deliverables={deliverables} density={density} />
        </RunSummaryRow>
      );
    case 'history':
      return <HistoryGroup exchanges={item.exchanges} />;
    case 'child':
      return <DelegationGroup job={item.job} from={item.from} deliverables={deliverables} />;
    case 'answer':
      // La réponse gardée (elle DIT autre chose que la dernière prose) est un
      // tour de l'agent, pas une plaque à part : c'est lui qui parle.
      return (
        <Turn>
          <Who name={agentName} avatarUrl={agentAvatarUrl} />
          <Markdown text={item.text} />
        </Turn>
      );
    case 'produced':
      // P7 — ce qui est sorti du chat à ce tour. Il ne paraît QUE là :
      // `buildConversationThread` ne pose l'item que sur un tour qui a produit.
      // P2bis — c'est devenu le RÉCAPITULATIF DE LIVRAISON : la liste des
      // items produits a laissé place aux chiffres du travail, aux relectures
      // et à la preuve, qui vivaient trois écrans plus bas.
      // #135 — le pied du récapitulatif ouvre le run qui l'a produit :
      // l'identifiant est DÉJÀ sur l'item, il n'avait jamais servi à l'écran.
      return <DeliveryBlock summary={item.summary} jobId={item.jobId} status={item.status} />;
    case 'handoff':
      // P7 — la consigne passée au travail. Repliée dans le style des notes :
      // la demande de l'utilisateur est juste au-dessus, écrite de sa main.
      return <Handoff text={item.text} />;
    case 'failure':
      return (
        <div className="mt-6">
          <CardFrame title="Failed" tone="warn">
            <div className="px-4 py-3">
              <Markdown text={item.text} />
              <HintLine hint={item.hint} />
            </div>
          </CardFrame>
        </div>
      );
  }
}

/**
 * LE GESTE, sous l'échec (#184). Le harnais nomme un geste en champ typé
 * (`hint: 'switch_model'`) et se garde d'écrire la phrase ; c'est ici qu'elle
 * s'écrit, courte, en anglais. Rien du tout quand aucun geste n'est nommé — ou
 * quand il l'est dans un mot que cet écran ne connaît pas : un slug brut
 * affiché ne serait un conseil pour personne.
 */
function HintLine({ hint }: { hint: string | null }) {
  const phrase = hintSentence(hint);
  if (phrase === null) return null;
  return <p className="pt-2 text-body-13 text-ink-3">{phrase}</p>;
}

/**
 * La voix de l'AGENT : à gauche, sur toute la colonne du fil. Pas de gouttière
 * d'avatar — elle décalait le texte du fil par rapport à la saisie du bas, qui
 * commence au bord (Quentin, 07/09). Les cartes du tour (outils, diff,
 * livraison) veulent cette largeur ; c'est la PROSE qui se borne, dans `Who`.
 */
function Turn({ children }: { children: React.ReactNode }) {
  return <div className="min-w-0 pt-6">{children}</div>;
}

/**
 * Qui parle, avec quel modèle, et à quelle heure — le composant `TurnHeader` du
 * tableau #135 : avatar carré, nom, modèle, puis l'heure de début poussée à
 * droite. Les nombres du tour ne sont plus là (#135) : ils ont leur bloc
 * (`ModelCallBlock`). Le modèle prend la couleur `feed/model` — sur une ligne,
 * la différence entre les choses est la COULEUR.
 *
 * L'heure ne se dessine QUE si le tour en porte une (invariant #4) : un tour
 * sans ligne d'audit n'a pas de date, et une heure devinée serait un mensonge
 * de plus à l'écran.
 */
function Who({
  name,
  avatarUrl,
  model,
  at,
}: {
  name: string;
  /** L'image de l'agent, quand il en a une. Sinon ses initiales (AgentAvatar). */
  avatarUrl?: string | null;
  model?: string | null;
  at?: Date | null;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2.5">
      <AgentAvatar name={name} imageUrl={avatarUrl ?? undefined} size="sm" shape="square" />
      <span className="text-title-15 text-ink">{name}</span>
      {model !== null && model !== undefined && model !== '' && (
        <span className="text-mono-11 text-feed-model">{model}</span>
      )}
      {at !== null && at !== undefined && (
        <span className="ml-auto text-mono-11 text-ink-4">{formatClock(at)}</span>
      )}
    </div>
  );
}

function Block({ block, deliverables }: { block: TurnBlock; deliverables: Deliverables }) {
  switch (block.kind) {
    case 'prose':
      return <Markdown text={block.text} className="mb-3" />;
    case 'steps': {
      // P2bis — plus de groupe « N tool calls » : le raisonnement se replie,
      // chaque appel d'outil se montre, dans l'ordre où il a eu lieu.
      const reasoning = block.steps
        .filter((s) => s.kind === 'reasoning')
        .map((s) => (s as Extract<typeof s, { kind: 'reasoning' }>).text);
      const tools = block.steps.filter((s): s is ToolStep => s.kind === 'tool');
      return (
        <div className="mb-3 space-y-2">
          {reasoning.length > 0 && <ThinkingBlock steps={reasoning} />}
          {tools.map((s, i) => (
            <ToolBlock key={i} step={s} />
          ))}
        </div>
      );
    }
    case 'card':
      return (
        <div className="mb-4">
          <ResultCard step={block.step} deliverables={deliverables} />
        </div>
      );
  }
}

// ─── Les cartes de résultat ───────────────────────────────────────────────────

function CardFrame({
  title,
  meta,
  aside,
  tone = 'neutral',
  children,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  aside?: React.ReactNode;
  tone?: 'neutral' | 'ok' | 'warn';
  children?: React.ReactNode;
}) {
  const head =
    tone === 'ok'
      ? 'bg-ok-bg'
      : tone === 'warn'
        ? 'bg-warn-bg'
        : 'bg-sidebar border-b border-rule-2';
  return (
    <div className="max-w-[760px] overflow-hidden rounded-xl border border-rule-2 bg-paper">
      <div className={`flex flex-wrap items-center gap-2.5 px-4 py-2.5 ${head}`}>
        <span className="text-medium-13 text-ink">{title}</span>
        {meta !== undefined && <span className="text-mono-11 text-ink-4">{meta}</span>}
        {aside !== undefined && <span className="ml-auto text-mono-11 text-ink-4">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

function ResultCard({ step, deliverables }: { step: ToolStep; deliverables: Deliverables }) {
  const p = step.presented;
  const duration = step.durationMs !== null ? formatMs(step.durationMs) : undefined;
  // P10a — la question passe AVANT la charge utile : sur l'appel qui a suspendu
  // le travail il n'y en a pas encore (rien n'a été exécuté), et c'est
  // exactement l'état où la carte doit porter les boutons. Ce qu'on montre vient
  // du `presented` quand il existe, de l'entrée relue sinon — jamais du nom de
  // l'outil.
  if (step.card === 'question') {
    const fromInput = readQuestionToolInput(step.input);
    const prompt = p?.card === 'question' ? p.prompt : (fromInput?.question ?? null);
    const options = p?.card === 'question' ? (p.options ?? []) : (fromInput?.options ?? []);
    if (prompt !== null && options.length > 0) {
      return (
        <QuestionCard
          prompt={<Markdown text={prompt} tone="user" />}
          options={options}
          question={step.question}
        />
      );
    }
    // Une question dont ni la charge ni l'entrée ne se lisent : le brut, dit
    // tel quel, plutôt qu'une carte vide qui prétendrait poser une question.
    return <ToolBlock step={step} />;
  }
  if (p === null) return <ToolBlock step={step} />;
  switch (p.card) {
    case 'table':
      return <TableCard payload={p} aside={duration} />;
    case 'files':
      return <FilesCard payload={p} step={step} aside={duration} deliverables={deliverables} />;
    case 'terminal':
      return <TerminalCard payload={p} />;
    case 'sent':
      return <SentCard payload={p} input={step.input} aside={duration} outcome={step.outcome} />;
    case 'checks':
      return <ChecksCard payload={p} />;
    case 'delegation':
      return <DelegationCard payload={p} />;
    default:
      // Une carte que l'écran ne dessine pas encore, ou un texte : le brut, dit
      // tel quel — jamais une devinette.
      //
      // #135 — ce brut n'est plus un GRAND cadre ouvert sur son JSON. Un appel
      // dont la carte manque (`assign_lead`, par exemple) prenait un demi-écran
      // pour ne rien dire de plus qu'une ligne ; il prend maintenant la même
      // ligne repliée que tous les autres appels, et l'aveu « brut » vit dans
      // son corps, sous `Result`.
      return <ToolBlock step={step} />;
  }
}

function TableCard({ payload, aside }: { payload: CardPayloadFor<'table'>; aside?: string }) {
  const totalRows = payload.tables.reduce((acc, t) => acc + t.total, 0);
  return (
    <CardFrame
      title={
        payload.tables.length === 1 && payload.tables[0]?.name ? payload.tables[0].name : 'Table'
      }
      meta={`${payload.tables.length > 1 ? `${payload.tables.length} sheets · ` : ''}${totalRows} rows`}
      aside={aside}
    >
      {payload.tables.map((t, i) => (
        <div key={i} className={i > 0 ? 'border-t border-rule-2' : ''}>
          {payload.tables.length > 1 && t.name && (
            <p className="px-4 pt-3 text-label-11 uppercase tracking-wider text-ink-4">{t.name}</p>
          )}
          <TableBody entry={t} />
        </div>
      ))}
    </CardFrame>
  );
}

/**
 * UNE table dessinée, et ce qu'elle doit dire d'elle-même. Extraite de
 * `TableCard` (P12) : l'aperçu d'un classeur écrit se rend par le même code,
 * sinon les deux tableaux divergeraient au premier correctif. `notes` ajoute
 * ce que l'APPELANT sait en plus (« values only », côté aperçu) au pied déjà
 * calculé depuis la charge utile.
 */
function TableBody({ entry, notes = [] }: { entry: TableEntry; notes?: readonly string[] }) {
  // La largeur montrée : l'en-tête, ou la ligne la plus large. Comparée à la
  // largeur réelle quand la charge utile la porte — une ligne antérieure au
  // plafond des colonnes ne dit rien, et l'écran ne devine pas.
  const shownWidth = Math.max(entry.columns.length, ...entry.rows.map((r) => r.length));
  const foot = [
    entry.truncated ? `showing ${entry.rows.length} of ${entry.total} rows` : null,
    entry.columnsTotal !== undefined && entry.columnsTotal > shownWidth
      ? `showing ${shownWidth} of ${entry.columnsTotal} columns`
      : null,
    entry.clipped ? 'some cells were shortened' : null,
    // Une feuille VIDE n'a pas de première ligne : la question de l'en-tête ne
    // se pose pas, et la poser faisait une note absurde sous « empty sheet ».
    entry.header === 'unknown' && entry.rows.length > 0
      ? 'first row may or may not be a header'
      : null,
    ...notes,
  ].filter((x): x is string => x !== null);
  return (
    <>
      <div className="overflow-x-auto">
        <Table frame={false}>
          {entry.header === 'columns' && entry.columns.length > 0 && (
            <THead>
              {entry.columns.map((c, j) => (
                <Th key={j}>{c}</Th>
              ))}
            </THead>
          )}
          <tbody>
            {entry.rows.map((r, ri) => (
              <Tr key={ri}>
                {r.map((cell, ci) => (
                  <Td
                    key={ci}
                    align={typeof cell === 'number' ? 'right' : 'left'}
                    className="max-w-[40ch] truncate text-mono-12 text-ink-2 whitespace-nowrap"
                  >
                    {cell === null ? '' : String(cell)}
                  </Td>
                ))}
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
      {foot.length > 0 && <p className="px-4 py-2 text-mono-11 text-ink-4">{foot.join(' · ')}</p>}
    </>
  );
}

/**
 * P12 — l'état de vérification d'un document, dit en une ligne.
 *
 * `not_configured` est le cas du jour : le vérificateur de documents (v7-B du
 * plan « Vérifier & Corriger ») n'existe pas encore, et la carte le DIT plutôt
 * que de laisser croire à une vérification. Un statut que cette table ne
 * connaît pas rend `null` : pas de ligne, jamais un état inventé (invariant #4).
 */
const VERIFICATION_NOTE: Readonly<Record<string, string>> = {
  not_configured: 'Not verified: no checks configured for this file',
  dirty: 'Not yet verified',
  pending_approval: 'Checks await approval',
  green: 'Verified',
  red: 'Checks failed',
  infra_error: 'Checks could not run',
};

/**
 * L'état de vérification d'un DOCUMENT sans aperçu — un `.md`, un `.css`, un
 * `.html` écrit hors de tout projet (« Créer, c'est prouver », point 4). Le
 * classeur a son aperçu et son état dessous ; un document n'a que son état,
 * et il se lit au même endroit.
 */
function DeliverableNote({ status }: { status: string | undefined }) {
  const note = status === undefined ? undefined : VERIFICATION_NOTE[status];
  if (note === undefined) return null;
  return <p className="border-t border-rule-2 px-4 py-2 text-mono-11 text-ink-4">{note}</p>;
}

/** L'aperçu d'un fichier écrit : ses premières lignes, ce qu'elles taisent, et son état. */
function FilePreview({ entry, status }: { entry: TableEntry; status: string | undefined }) {
  const note = status === undefined ? undefined : VERIFICATION_NOTE[status];
  return (
    <div className="border-t border-rule-2">
      {/* La feuille touchée se nomme : un classeur en a plusieurs, et l'aperçu
          n'en montre qu'une. */}
      {entry.name !== undefined && (
        <p className="px-4 pt-3 text-label-11 uppercase tracking-wider text-ink-4">{entry.name}</p>
      )}
      {/* Ce que l'aperçu tait, dit sans se contredire : une formule que
          personne n'a calculée s'affiche telle qu'écrite (« =SUM(A1:A2) »),
          donc le pied ne peut pas prétendre « no formulas » (revue Codex
          PR #46, passe 46). */}
      <TableBody
        entry={entry}
        notes={[
          ...(entry.total === 0 ? ['empty sheet'] : []),
          'no formatting or merged cells; uncomputed formulas shown as written',
        ]}
      />
      {note !== undefined && (
        <p className="border-t border-rule-2 px-4 py-2 text-mono-11 text-ink-4">{note}</p>
      )}
    </div>
  );
}

function FilesCard({
  payload,
  step,
  aside,
  deliverables,
}: {
  payload: CardPayloadFor<'files'>;
  step: ToolStep;
  aside?: string;
  deliverables: Deliverables;
}) {
  // P2bis — « DIFF REVIEW » quand l'agent a ÉCRIT, « FILES » quand il n'a fait
  // que lire. Les compteurs « −2 +27 » viennent de l'ENTRÉE de l'appel, lue
  // par `coding-changes.ts` : la même lecture que la page Code, donc les mêmes
  // nombres sur les deux écrans. Un fichier écrit par un outil sans texte (un
  // classeur) n'en a pas — et n'affiche rien, plutôt qu'un zéro.
  const wrote = payload.files.some((f) => f.action !== 'listed');
  const perFile = payload.files.map((f) => findLineCounts(step.lineCounts, f.path));
  const total = perFile.reduce<LineCounts | null>(
    (acc, c) =>
      c === null
        ? acc
        : { added: (acc?.added ?? 0) + c.added, removed: (acc?.removed ?? 0) + c.removed },
    null,
  );
  return (
    <div className="overflow-hidden rounded-xl border border-rule-2 bg-canvas">
      <div className="flex h-[35px] items-center gap-2.5 px-3.5">
        <MonoMicroTag tone="ink">{wrote ? 'diff review' : 'files'}</MonoMicroTag>
        <span className="text-mono-11 text-ink-3">
          {payload.total} {payload.total === 1 ? 'file' : 'files'}
          {payload.truncated ? ` · showing ${payload.files.length}` : ''}
        </span>
        <span className="ml-auto flex items-center gap-2.5">
          <LineDelta counts={total} />
          {aside !== undefined && <span className="text-mono-11 text-ink-4">{aside}</span>}
        </span>
      </div>
      <ul className="border-t border-rule-2">
        {payload.files.map((f, i) => {
          const counts = perFile[i] ?? null;
          // P12 — l'aperçu se pose SOUS la ligne du fichier, au-dessus du diff
          // de P11. L'état de vérification ne se lit que si l'outil a écrit la
          // clé du livrable ET que CE job porte une ligne pour elle.
          const status =
            f.deliverableKey === undefined
              ? undefined
              : deliverables.get(deliverableStatusKey(step.jobId, f.deliverableKey));
          // Un document sans aperçu (un `.md`, un `.css`) montre quand même son
          // état : c'est la seule chose que « Vérifié » a à dire de lui.
          const preview =
            f.preview !== undefined ? (
              <FilePreview entry={f.preview} status={status} />
            ) : status !== undefined ? (
              <DeliverableNote status={status} />
            ) : undefined;
          // P11 — un fichier ÉCRIT se déplie sur son diff. Un fichier `listed`
          // vient d'une lecture : il n'a pas d'avant, donc pas de bouton — une
          // pastille qui s'ouvrirait sur « aucun changement » serait pire que
          // pas de pastille. Sans identifiant d'appel il n'y a rien à demander
          // au runner (les lignes d'audit anciennes n'en ont pas).
          if (f.action !== 'listed' && step.toolCallId !== null) {
            return (
              <FileDiff
                key={i}
                jobId={step.jobId}
                toolCallId={step.toolCallId}
                path={f.path}
                action={f.action}
                lineCounts={counts}
                {...(f.bytes !== undefined ? { bytes: `${formatTokens(f.bytes)} B` } : {})}
                {...(f.detail !== undefined ? { detail: f.detail } : {})}
                {...(preview !== undefined ? { preview } : {})}
              />
            );
          }
          // Un fichier seulement LU n'a pas de diff à ouvrir : même ligne, sans
          // chevron — la gouttière de 14 px du chevron est rendue en marge
          // pour que les chemins restent alignés d'une ligne à l'autre.
          return (
            <li key={i} className="border-t border-rule-2 first:border-t-0">
              <div className="flex h-[42px] items-center gap-2 pr-3.5 pl-[38px]">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${FILE_DOT[f.action] ?? 'bg-ink-4'}`}
                />
                <FileName path={f.path} />
                <LineDelta counts={counts} />
                {f.bytes !== undefined && (
                  <span className="shrink-0 text-mono-11 text-ink-4">
                    {formatTokens(f.bytes)} B
                  </span>
                )}
                {f.detail !== undefined && (
                  <span className="max-w-[40%] shrink-0 truncate text-mono-11 text-ink-4">
                    {f.detail}
                  </span>
                )}
              </div>
              {preview}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TerminalCard({ payload }: { payload: CardPayloadFor<'terminal'> }) {
  const failed = payload.timedOut || (payload.exitCode !== null && payload.exitCode !== 0);
  return (
    <CardFrame
      title={<span className="text-mono-12 text-ink">{payload.command}</span>}
      aside={
        <MonoMicroTag tone={failed ? 'err' : 'ink'}>
          {payload.timedOut ? 'timed out' : `exit ${payload.exitCode ?? '?'}`}
        </MonoMicroTag>
      }
      tone={failed ? 'warn' : 'neutral'}
    >
      {payload.stdoutTail !== '' && (
        <pre className="max-h-64 overflow-auto px-4 py-3 text-mono-11 text-ink-2 whitespace-pre-wrap break-words">
          {payload.stdoutTruncated ? '… (earlier output not kept)\n' : ''}
          {payload.stdoutTail}
        </pre>
      )}
      {payload.stderrTail !== '' && (
        <pre className="max-h-64 overflow-auto border-t border-rule-2 px-4 py-3 text-mono-11 text-err whitespace-pre-wrap break-words">
          {payload.stderrTruncated ? '… (earlier output not kept)\n' : ''}
          {payload.stderrTail}
        </pre>
      )}
      {payload.stdoutTail === '' && payload.stderrTail === '' && (
        <p className="px-4 py-3 text-body-12 text-ink-4">No output.</p>
      )}
    </CardFrame>
  );
}

/**
 * Ce qui est SORTI du chat, replié comme tout bloc de run (#135). C'était le
 * dernier grand cadre du fil : un envoi de deux lignes prenait un demi-écran,
 * bandeau vert compris, là où l'appel d'outil juste au-dessus tenait sur 33 px
 * (constat de Quentin sur sa pile, 17/09).
 *
 * Le verdict ne passe plus par un bandeau coloré, il passe par la PASTILLE —
 * la même que celle du bloc d'outil, lue sur l'issue de l'appel. Le message
 * envoyé, lui, descend dans le corps : c'est ce qu'on va CHERCHER, pas ce
 * qu'on lit en parcourant.
 */
function SentCard({
  payload,
  input,
  aside,
  outcome,
}: {
  payload: CardPayloadFor<'sent'>;
  input: unknown;
  aside?: string;
  outcome: ToolStep['outcome'];
}) {
  const text =
    input && typeof input === 'object' && typeof (input as { text?: unknown }).text === 'string'
      ? (input as { text: string }).text
      : null;
  const meta = [payload.kind, payload.filename, payload.target ? `to ${payload.target}` : null]
    .filter((x): x is string => typeof x === 'string' && x !== '')
    .join(' · ');
  const head = (
    <>
      <PaperPlaneTilt size={14} className="shrink-0 text-ink-4" aria-hidden />
      <span className="shrink-0 text-mono-12 text-ink">Sent to {payload.channel}</span>
      {meta !== '' && (
        <span className="min-w-0 flex-1 truncate text-mono-12 text-ink-3">{meta}</span>
      )}
      <span
        className={`ml-auto h-2 w-2 shrink-0 rounded-full ${DOT[outcome] ?? 'bg-ink-4'}`}
        aria-hidden
      />
      {aside !== undefined && (
        <span className="shrink-0 text-mono-12 text-feed-metric">{aside}</span>
      )}
    </>
  );
  // Un envoi sans message ET sans taille n'a rien à ouvrir : il garde sa ligne,
  // sans chevron — la même règle que pour un appel muet (`hasBody`).
  const body =
    text !== null || payload.bytes !== undefined ? (
      <FoldableBody>
        {text !== null && <Markdown text={text} />}
        {payload.bytes !== undefined && (
          <p className="text-mono-11 text-ink-4">{formatTokens(payload.bytes)} B</p>
        )}
      </FoldableBody>
    ) : undefined;
  return <FoldableBlock head={head} {...(body !== undefined ? { body } : {})} />;
}

function ChecksCard({ payload }: { payload: CardPayloadFor<'checks'> }) {
  const pass = payload.verdict === 'pass';
  return (
    <CardFrame
      title={pass ? 'Review: approved' : 'Review: changes requested'}
      meta={`${payload.total} ${payload.total === 1 ? 'finding' : 'findings'}`}
      tone={pass ? 'ok' : 'warn'}
    >
      <div className="px-4 py-3">
        <Markdown text={payload.summary} />
      </div>
      {payload.items.length > 0 && (
        <ul className="border-t border-rule-2">
          {payload.items.map((it, i) => (
            <li
              key={i}
              className="flex items-start gap-3 border-b border-rule-2 px-4 py-2.5 last:border-b-0"
            >
              <MonoMicroTag tone={it.ok ? 'agent' : it.severity === 'blocker' ? 'err' : 'warn'}>
                {it.ok ? 'ok' : (it.severity ?? 'issue')}
              </MonoMicroTag>
              <span className="min-w-0 flex-1 text-body-13 text-ink-2">
                {it.label}
                {it.ref !== undefined && (
                  <span className="mt-0.5 block text-mono-11 text-ink-4">{it.ref}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </CardFrame>
  );
}

/** L'en-tête d'un bloc déplié : « TASK », « RESULT ». */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 text-label-11 uppercase tracking-wider text-ink-4">{children}</p>;
}

/**
 * Ce qu'un délégué a rendu, en une ligne : la première ligne PLATE de son
 * résultat — c'est ce qu'un lecteur vient chercher. Sans résultat (il court
 * encore, il a échoué), la consigne qu'il a reçue le remplace : dire de quoi
 * il s'agit vaut mieux qu'une ligne vide.
 */
function delegationTitle(result: string | null, task: string | null): string {
  const source = result !== null && result.trim() !== '' ? result : (task ?? '');
  if (source.trim() === '') return 'No result yet';
  return truncate(plainText(source), 80);
}

function DelegationCard({ payload }: { payload: CardPayloadFor<'delegation'> }) {
  return (
    <DelegationDisclosure
      label={`Delegated to ${payload.to}`}
      title={delegationTitle(payload.resultText, payload.task)}
      ok={payload.ok}
      aside={[
        payload.durationMs !== null ? formatMs(payload.durationMs) : null,
        payload.costUsd !== null ? formatCost(payload.costUsd) : null,
      ]
        .filter((x): x is string => x !== null)
        .join(' · ')}
    >
      <div className="px-4 py-3">
        <SectionLabel>Task</SectionLabel>
        <Markdown text={payload.task} />
      </div>
      {payload.resultText !== null && (
        <div className="border-t border-rule-2 px-4 py-3">
          <SectionLabel>Result</SectionLabel>
          <Markdown text={payload.resultText} />
        </div>
      )}
      {payload.error !== null && (
        <p className="border-t border-rule-2 px-4 py-3 text-body-13 text-err">{payload.error}</p>
      )}
    </DelegationDisclosure>
  );
}

/** Le label d'un bloc déplié, dans la graisse du tableau : « Task », « What the child did ». */
function BlockLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-mono-11 text-ink-4">{children}</p>;
}

/**
 * Le verdict rendu par un délégué, quand il en a écrit un — jamais déduit.
 *
 * La seule forme que ce fil sait reconnaître sans deviner est celle que les
 * agents de revue écrivent VRAIMENT, telle qu'elle est dans `agent_jobs.result`
 * (relevé du 17/09) : une première ligne « Verdict », « Verdict global »,
 * « Verdict final », suivie de deux points ou d'un tiret cadratin — ou le mot
 * seul sur sa ligne, le verdict étant alors la ligne suivante. La forme EN
 * LIGNE n'accepte PAS le trait d'union : un tiret est trop banal pour découper
 * une phrase sans risque. Le mot seul, lui, l'accepte, et la raison est plus
 * bas — sur une ligne qui s'arrête là, il n'y a plus de phrase à découper.
 *
 * Tout le reste rend `null` et la ligne n'est pas dessinée : inventer un
 * verdict à partir de la première phrase d'un résultat quelconque ferait dire
 * au délégué ce qu'il n'a pas dit (invariant #4). « Verdict émis. Je clos la
 * tâche. » — une vraie ligne de la base — est bien écarté.
 *
 * La ligne rendue est la PREMIÈRE, parce que le pied du bloc tient sur une
 * ligne. Le reste n'est pas perdu : le corps montre le résultat en entier,
 * juste au-dessus (« Result », ou le fil du délégué qui porte sa réponse).
 *
 * CE QU'EST « LA LIGNE SUIVANTE » (#198)
 * --------------------------------------
 * La branche « le mot seul, le verdict en dessous » ne s'est jamais déclenchée
 * jusqu'au 20/09/2026 : la règle lisait `plainText`, qui ne rend que la
 * première ligne du PREMIER bloc, si bien que « Verdict\nça passe » arrivait
 * ici comme « Verdict » tout court et que la suite était toujours absente.
 * C'est #195 qui l'a constaté, en écrivant les tests de #174 : la branche y a
 * été documentée et son comportement réel épinglé, plutôt que réparé dans une
 * PR qui portait sur autre chose.
 *
 * Elle est RÉPARÉE plutôt que supprimée, parce que la famille qu'elle vise
 * existe vraiment : un relecteur qui titre « ## Verdict » et pose sa phrase en
 * dessous a dit son verdict, et le taire n'était pas de la prudence, c'était
 * une ligne perdue. La règle lit donc les DEUX premières lignes lisibles du
 * markdown (`plainLines`), blocs traversés.
 *
 * LE MOT SEUL PORTE SON SÉPARATEUR. « Verdict: » sur sa ligne, le verdict en
 * dessous, rendait `null` : la forme en ligne exige un contenu APRÈS le
 * séparateur, et `/^verdict$/i` échouait sur le deux-points resté là. C'était
 * le défaut d'origine de cette branche, sur une formulation réelle (Reviewer C,
 * passe 1 de la PR #278). Le séparateur est donc optionnel quand il ne reste
 * rien derrière.
 *
 * ET LÀ, le TIRET est accepté — les trois, cadratin, demi-cadratin et trait
 * d'union — alors que la forme en ligne n'en accepte aucun. Ce n'est pas une
 * incohérence, c'est la même prudence appliquée à deux situations qui ne se
 * ressemblent pas. En ligne, un tiret sépare des phrases tout le temps, et
 * « Verdict - ça passe » n'est pas distinguable d'une phrase qui commence par
 * le mot. Sur une ligne qui s'arrête au tiret, il ne reste RIEN derrière : le
 * tiret ne peut plus découper quoi que ce soit, il ne fait qu'annoncer la
 * suite (Reviewer C, passe 2 de la PR #278).
 *
 * Le qualificatif, lui, n'est PAS accepté sur cette branche-là, alors que la
 * forme en ligne l'accepte (« Verdict global : … »). La raison tient en une
 * ligne de la base : « Verdict émis. Je clos la tâche. » Écrite en deux
 * paragraphes, « Verdict émis. » passerait pour le mot seul et la phrase
 * suivante deviendrait un verdict que personne n'a rendu.
 *
 * La ligne suivante ne compte que si elle vient d'un PARAGRAPHE. C'est la
 * décision pour le milieu ambigu, et elle est explicite : sous « ## Verdict »,
 * une LISTE de constats n'est pas un verdict d'une ligne, et en promouvoir la
 * première puce ferait dire au délégué ce qu'il n'a pas dit (invariant #4).
 * Un tel résultat ne dessine aucune ligne, et le corps montre la liste entière.
 * Le cas « Verdict\nça passe » passe par la même porte : les deux lignes sont
 * celles d'un seul paragraphe.
 *
 * Un SOUS-TITRE (« ### Approve ») et une CITATION (« > approve ») sous le mot
 * sont écartés par la même règle, et c'est voulu : ni l'un ni l'autre n'est la
 * phrase d'un relecteur. Le second est d'ordinaire une consigne recopiée, et
 * la prendre pour un verdict serait lire la question comme la réponse.
 */
export function delegationVerdict(result: string | null): string | null {
  if (result === null) return null;
  const [head, next] = plainLines(result, 2);
  if (head === undefined) return null;
  const inline = /^verdict(?:\s+[^\s:—]+)?\s*[:—]\s*(.+)$/i.exec(head.text);
  if (inline?.[1] !== undefined) return inline[1];
  if (/^verdict\s*[:—–-]?$/i.test(head.text)) {
    return next !== undefined && next.block === 'paragraph' ? next.text : null;
  }
  return null;
}

/**
 * La ligne de verdict d'une délégation : L'ENREGISTRÉ D'ABORD, la prose ensuite
 * (#174).
 *
 * Le fil lisait la première ligne du résultat de l'enfant. Depuis #170 l'outil
 * `review_verdict` écrit le verdict TYPÉ — validé par son schéma, compté par
 * gravité — et une prose qui dit autre chose ne doit plus gagner : un
 * relecteur qui écrit « Verdict global : rien à signaler » après avoir
 * enregistré `request_changes` avec deux bloquants faisait afficher au bloc le
 * contraire de ce qu'il a livré.
 *
 * Ce qui s'écrit alors : le mot du verdict, puis les constats PAR GRAVITÉ, et
 * seulement les gravités présentes. « 0 minor » demande d'être lu pour
 * apprendre qu'il n'y a rien ; une revue propre s'écrit « Approved », un point
 * c'est tout.
 *
 * La prose reste le repli, mot pour mot : un délégué qui n'a enregistré aucun
 * verdict n'a que ça, et c'est toujours mieux qu'une ligne vide.
 */
export function delegationVerdictLine(job: {
  result: string | null;
  reviewVerdict?: ReviewVerdictRecord | null;
}): string | null {
  const record = job.reviewVerdict;
  if (record === undefined || record === null) return delegationVerdict(job.result);
  const mot = record.verdict === 'approve' ? 'Approved' : 'Changes requested';
  const compte = (
    [
      ['blocker', record.counts.blocker],
      ['major', record.counts.major],
      ['minor', record.counts.minor],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([nom, n]) => `${n} ${nom}${n > 1 ? 's' : ''}`)
    .join(', ');
  return compte === '' ? mot : `${mot} · ${compte}`;
}

/**
 * Un travail confié à un autre agent, dépliable (#135).
 *
 * La tête se lit comme une phrase : qui a délégué, à qui, pour quoi. C'est ce
 * qui permet de garder TOUT replié et de suivre quand même la chaîne — une
 * délégation n'est jamais imbriquée dans une autre, le fil la remonte au même
 * niveau (`buildConversationFeed`).
 *
 * La consigne reçue et la réponse rendue sont ce qu'un lecteur vient chercher
 * quand il ouvre : c'est là qu'un malentendu se voit.
 */
function DelegationGroup({
  job,
  from,
  deliverables,
}: {
  job: FeedChildJob;
  from: { name: string | null; slug: string | null; avatarUrl: string | null };
  deliverables: Deliverables;
}) {
  const durationMs =
    job.completedAt !== null && job.createdAt !== null
      ? job.completedAt.getTime() - job.createdAt.getTime()
      : null;
  // Le fil du délégué, quand l'appelant l'a assemblé (un niveau, job-feed.ts) :
  // ses tours, ses cartes, sa réponse — SANS sa demande, qui est la consigne
  // du parent, déjà écrite sous « Task » ; un « You » y serait faux, c'est
  // l'agent parent qui a demandé. Et SANS ses propres délégations : elles sont
  // remontées au niveau du dessus, c'est la règle du tableau. Le filtre les
  // redit ici pour que la règle tienne même sur un fil assemblé à la main.
  const nested = job.feed?.items.filter(
    (i) => i.kind !== 'request' && i.kind !== 'history' && i.kind !== 'child',
  );
  const totals = job.feed?.totals;
  // Chaque part disparaît quand on ne la connaît pas : jamais « $0 », jamais
  // « 0 tokens » (principe du tableau). Le fil d'un délégué porte TOUJOURS des
  // totaux dès qu'il est assemblé, à zéro tant qu'aucun appel de modèle n'a été
  // enregistré : c'est la SOMME qui dit si on sait quelque chose, pas la
  // présence de l'objet (revue de la PR #141).
  const tokens = totals === undefined ? 0 : totals.inputTokens + totals.outputTokens;
  const metrics = [
    durationMs !== null && durationMs > 0 ? formatMs(durationMs) : null,
    tokens > 0 ? `${formatTokens(tokens)} tokens` : null,
    totals && totals.costUsd !== null ? formatCost(totals.costUsd) : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');
  const fromName = from.name ?? 'An agent';
  const toName = job.agentName ?? 'an agent';
  const failed = job.status === 'failed' || job.status === 'cancelled';
  const done = job.status === 'completed';
  const summary = job.task !== null ? truncate(plainText(job.task), 80) : '';
  const verdict = delegationVerdictLine(job);
  // Pleine largeur, comme tout bloc du fil (#135, remarque de Quentin sur
  // #140) : la gouttière de 46 px rentrait la délégation par rapport aux blocs
  // d'outil juste au-dessus, et le fil se lisait en escalier.
  return (
    <div className="mt-4">
      <DelegationBlock
        head={
          <>
            <AgentAvatar
              name={fromName}
              imageUrl={from.avatarUrl ?? undefined}
              size="sm"
              shape="square"
            />
            <span className="shrink-0 text-medium-13 text-ink">{fromName}</span>
            {/* Sans capitales : le tableau écrit « delegated to », pas un label. */}
            <span className="shrink-0 text-body-13 text-feed-delegation">delegated to</span>
            <AgentAvatar
              name={toName}
              imageUrl={job.agentAvatarUrl ?? undefined}
              size="sm"
              shape="square"
            />
            <span className="shrink-0 text-medium-13 text-ink">{toName}</span>
            <span className="min-w-0 flex-1 truncate text-body-13 text-ink-3">{summary}</span>
            {/* LE VERDICT DANS LA TÊTE (#174), et plus au fond du bloc : on
                parcourt un fil de revues replié, et la conclusion de chacune
                est justement ce qu'on cherche sans l'ouvrir. Coupé à une
                trentaine de signes, parce que le repli d'une prose peut être
                une phrase entière — le verdict ENREGISTRÉ, lui, tient
                toujours. */}
            {verdict !== null && (
              <span className="max-w-[30ch] shrink-0 truncate text-body-13 text-feed-delegation">
                {verdict}
              </span>
            )}
            {/* La pastille dit d'un coup d'œil si la passe a atterri ; elle ne
                se dessine pas tant que le délégué court (rien à dire encore). */}
            {(done || failed) && (
              /* `data-outcome` dit CE QUE la pastille annonce ; la classe dit
                 seulement de quelle couleur elle est. Le parcours de #55 lisait
                 `span.bg-err`, donc un jeton de thème : le renommer aurait rendu
                 muet le test qui prouve qu'une délégation ratée se voit. */
              <span
                data-outcome={done ? 'ok' : 'failed'}
                className={`h-2 w-2 shrink-0 rounded-full ${done ? 'bg-ok' : 'bg-err'}`}
              />
            )}
            <StatusPill
              variant={done ? 'done' : failed ? 'warn' : 'run'}
              label={done ? 'Done' : failed ? 'Failed' : 'Running'}
              className="shrink-0"
            />
            {metrics !== '' && (
              <span className="shrink-0 text-mono-11 text-feed-metric">{metrics}</span>
            )}
          </>
        }
        body={
          <div className="flex flex-col gap-2 pt-2.5 pr-3.5 pb-3 pl-10">
            {job.task !== null && (
              <div>
                <BlockLabel>Task</BlockLabel>
                <div className="text-body-13 text-ink-2">
                  <Markdown text={job.task} />
                </div>
              </div>
            )}
            {nested !== undefined && nested.length > 0 ? (
              // Le fil du délégué porte déjà sa réponse (`answer`) ou son échec
              // (`failure`) : le résultat et l'erreur ne se répètent pas dessous.
              <div>
                <BlockLabel>What the child did</BlockLabel>
                <FeedItems items={nested} deliverables={deliverables} />
              </div>
            ) : (
              <>
                {job.result !== null && (
                  <div>
                    <BlockLabel>Result</BlockLabel>
                    <div className="text-body-13 text-ink-2">
                      <Markdown text={job.result} />
                    </div>
                  </div>
                )}
                {job.error !== null && <p className="text-body-13 text-err">{job.error}</p>}
                {/* Le geste que l'échec du délégué appelle, LU sur sa ligne
                    comme le fil le lit pour un run (#193). */}
                <HintLine hint={job.failureHint} />
              </>
            )}
            {/* Le RÉSUMÉ du verdict enregistré, ici et pas dans la tête : la
                tête porte la conclusion, le corps porte ce qui la justifie. La
                prose n'a pas de résumé à part — son verdict EST sa phrase, déjà
                dans la tête et déjà dans « Result » juste au-dessus. */}
            {job.reviewVerdict != null && job.reviewVerdict.summary !== '' && (
              <div>
                <BlockLabel>Verdict</BlockLabel>
                <p className="text-body-13 text-ink-2">{job.reviewVerdict.summary}</p>
              </div>
            )}
            {/* P8 : le fil d'un JOB vit sur /scheduled/[id] — /spaces/<id> est
                devenu la page d'un PROJET. */}
            <div className="flex items-center justify-end gap-3">
              {/* ARRÊTER CE RUN D'ICI (Quentin, 22/09 : « il y a un bouton
                  Open run, je devrais pouvoir le stopper »). Le bouton vit à
                  côté du lien qu'on regarde, pour le job de CE bloc ; il se
                  cache tout seul dès que le job n'est plus vivant. */}
              {canStopRun(job.status) && <StopRunButton jobId={job.id} status={job.status} />}
              <Link
                href={`/scheduled/${job.id}`}
                className="flex shrink-0 items-center gap-1.5 text-medium-13 text-ink-2 hover:text-ink"
              >
                Open run
                <ArrowSquareOut size={14} aria-hidden />
              </Link>
            </div>
          </div>
        }
      />
    </div>
  );
}
