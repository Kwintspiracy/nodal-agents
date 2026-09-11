// ConversationFeedView — le fil dessiné (P2, plan « De la maquette au
// produit »). Rendu côté serveur depuis `ConversationFeed` ; dispatche sur la
// CARTE persistée par P1 (`presented.card`), jamais sur le nom de l'outil. Ce
// qu'il ne sait pas dessiner, il le montre brut et le dit.

import Link from 'next/link';
import AgentAvatar from '@/components/ui/AgentAvatar';
import ClampedText from './ClampedText.tsx';
import Table, { THead, Th, Tr, Td } from '@/components/ui/Table';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import type { CardPayloadFor, TableEntry } from '@nodal-agents/shared';
import { readQuestionToolInput } from '@nodal-agents/shared';
import { deliverableStatusKey, type DeliverableStatusView } from '@/lib/verification-runs-view.ts';
import { findLineCounts, type LineCounts } from '@/lib/coding-changes.ts';
import type {
  ConversationFeed,
  FeedChildJob,
  FeedItem,
  Step,
  TurnBlock,
} from '@/lib/conversation-feed.ts';
import Markdown, { plainText } from '@/components/Markdown.tsx';
import { truncate } from '@/lib/format-time';
import ThinkingBlock from './ThinkingBlock.tsx';
import ToolBlock from './ToolBlock.tsx';
import DeliveryBlock from './DeliveryBlock.tsx';
import QuestionCard from './QuestionCard.tsx';
import FileDiff, { FILE_DOT, FileName, LineDelta } from './FileDiff.tsx';
import HistoryGroup from './HistoryGroup.tsx';
import DelegationDisclosure from './DelegationDisclosure.tsx';
import Handoff from './Handoff.tsx';
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
}: {
  feed: ConversationFeed;
  deliverables?: ReadonlyArray<DeliverableStatusView>;
}) {
  if (feed.items.length === 0) {
    return <p className="text-body-13 text-ink-4">Nothing recorded yet.</p>;
  }
  const byKey: Deliverables = new Map(
    deliverables.map((d) => [deliverableStatusKey(d.jobId, d.canonicalKey), d.status]),
  );
  return (
    <div className="mx-auto max-w-[760px]">
      <FeedItems items={feed.items} deliverables={byKey} />
    </div>
  );
}

/**
 * Les items d'un fil, sans cadre : le fil de la page en haut, et le fil d'un
 * DÉLÉGUÉ sous sa carte de délégation (P2bis) passent par le même code.
 */
function FeedItems({ items, deliverables }: { items: FeedItem[]; deliverables: Deliverables }) {
  // La réponse finale se rend comme un TOUR : il lui faut donc un nom et un
  // avatar. Le fil ne les porte pas sur l'item ; ils viennent du dernier tour
  // de l'agent, qui est celui qui l'a écrite.
  const lastTurn = [...items].reverse().find((i) => i.kind === 'turn');
  const agentName = lastTurn?.agent.name ?? 'Agent';
  return (
    <>
      {items.map((item, i) => (
        <FeedItemView key={i} item={item} deliverables={deliverables} agentName={agentName} />
      ))}
    </>
  );
}

function FeedItemView({
  item,
  deliverables,
  agentName,
}: {
  item: FeedItem;
  deliverables: Deliverables;
  agentName: string;
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
      // Ce que le tour a coûté descend dans le bloc de RÉFLEXION quand il y en
      // a un : le design y met « 3 étapes · 7,2 s · 9 120 jetons », et la ligne
      // du nom ne porte alors que le modèle. Sans réflexion, elle garde tout —
      // sinon ces nombres n'auraient nulle part où aller.
      // La durée est celle des appels LLM du tour (le temps de penser) : celle
      // des outils est sur chaque `ToolBlock`, ligne par ligne, donc les deux
      // ne se confondent plus comme du temps du groupe.
      const cost = [
        item.usage && item.usage.durationMs > 0 ? formatMs(item.usage.durationMs) : null,
        item.usage
          ? `${formatTokens(item.usage.inputTokens + item.usage.outputTokens)} tokens`
          : null,
        item.usage && item.usage.costUsd !== null ? formatCost(item.usage.costUsd) : null,
      ].filter((x): x is string => x !== null);
      // Le PREMIER bloc qui porte du raisonnement reçoit le coût ; les suivants
      // (rares) n'en portent pas, sinon le même nombre paraîtrait deux fois.
      const firstThinking = item.blocks.findIndex(
        (b) => b.kind === 'steps' && b.steps.some((st) => st.kind === 'reasoning'),
      );
      const meta =
        firstThinking >= 0
          ? (item.model ?? '')
          : [item.model, ...cost].filter((x): x is string => typeof x === 'string').join(' · ');
      return (
        <Turn>
          <Who name={item.agent.name ?? 'Agent'} meta={meta} />
          {item.blocks.map((b, i) => (
            <Block
              key={i}
              block={b}
              deliverables={deliverables}
              {...(i === firstThinking && cost.length > 0 ? { meta: cost.join(' · ') } : {})}
            />
          ))}
        </Turn>
      );
    }
    case 'history':
      return <HistoryGroup exchanges={item.exchanges} />;
    case 'child':
      return <DelegationGroup job={item.job} deliverables={deliverables} />;
    case 'answer':
      // La réponse gardée (elle DIT autre chose que la dernière prose) est un
      // tour de l'agent, pas une plaque à part : c'est lui qui parle.
      return (
        <Turn>
          <Who name={agentName} meta="" />
          <Markdown text={item.text} />
        </Turn>
      );
    case 'produced':
      // P7 — ce qui est sorti du chat à ce tour. Il ne paraît QUE là :
      // `buildConversationThread` ne pose l'item que sur un tour qui a produit.
      // P2bis — c'est devenu le RÉCAPITULATIF DE LIVRAISON : la liste des
      // items produits a laissé place aux chiffres du travail, aux relectures
      // et à la preuve, qui vivaient trois écrans plus bas.
      return <DeliveryBlock summary={item.summary} />;
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
            </div>
          </CardFrame>
        </div>
      );
  }
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

function Who({ name, meta }: { name: string; meta: string }) {
  return (
    <div className="mb-1.5 flex items-baseline gap-2">
      <span className="text-title-15 text-ink">{name}</span>
      {meta !== '' && <span className="text-mono-11 text-ink-3">{meta}</span>}
    </div>
  );
}

function Block({
  block,
  deliverables,
  meta,
}: {
  block: TurnBlock;
  deliverables: Deliverables;
  /** Ce que le TOUR ajoute à l'en-tête du groupe : jetons, durée, coût. */
  meta?: string;
}) {
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
          {reasoning.length > 0 && (
            <ThinkingBlock steps={reasoning} {...(meta !== undefined ? { meta } : {})} />
          )}
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
    return <RawCard step={step} />;
  }
  if (p === null) return <RawCard step={step} />;
  switch (p.card) {
    case 'table':
      return <TableCard payload={p} aside={duration} />;
    case 'files':
      return <FilesCard payload={p} step={step} aside={duration} deliverables={deliverables} />;
    case 'terminal':
      return <TerminalCard payload={p} />;
    case 'sent':
      return <SentCard payload={p} input={step.input} aside={duration} />;
    case 'checks':
      return <ChecksCard payload={p} />;
    case 'delegation':
      return <DelegationCard payload={p} />;
    default:
      // Une carte que l'écran ne dessine pas encore, ou un texte : le brut, dit
      // tel quel — jamais une devinette.
      return <RawCard step={step} />;
  }
}

/** Rien de présentable : l'entrée et la sortie brutes, en le disant. */
function RawCard({ step }: { step: ToolStep }) {
  return (
    <CardFrame
      title={step.toolName}
      meta={step.card === null ? 'no card recorded' : `${step.card} · raw`}
      aside={step.durationMs !== null ? formatMs(step.durationMs) : undefined}
    >
      <pre className="max-h-64 overflow-auto px-4 py-3 text-mono-11 text-ink-3 whitespace-pre-wrap break-words">
        {JSON.stringify(step.input, null, 2)}
      </pre>
      {step.outputText !== null && (
        <pre className="max-h-64 overflow-auto border-t border-rule-2 px-4 py-3 text-mono-11 text-ink-2 whitespace-pre-wrap break-words">
          {step.outputText}
        </pre>
      )}
    </CardFrame>
  );
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

function SentCard({
  payload,
  input,
  aside,
}: {
  payload: CardPayloadFor<'sent'>;
  input: unknown;
  aside?: string;
}) {
  const text =
    input && typeof input === 'object' && typeof (input as { text?: unknown }).text === 'string'
      ? (input as { text: string }).text
      : null;
  return (
    <CardFrame
      title={`Sent to ${payload.channel}`}
      meta={[payload.kind, payload.filename, payload.target ? `to ${payload.target}` : null]
        .filter((x): x is string => typeof x === 'string' && x !== '')
        .join(' · ')}
      aside={aside}
      tone="ok"
    >
      {text !== null && (
        <div className="px-4 py-3">
          <Markdown text={text} />
        </div>
      )}
      {payload.bytes !== undefined && (
        <p className="px-4 pb-3 text-mono-11 text-ink-4">{formatTokens(payload.bytes)} B</p>
      )}
    </CardFrame>
  );
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

/**
 * Un travail confié à un autre agent, dépliable (P2bis).
 *
 * La consigne reçue et la réponse rendue sont ce qu'un lecteur vient chercher
 * quand il ouvre une délégation : c'est là qu'un malentendu se voit. Elles
 * étaient tronquées à une ligne. Le fil de l'enfant, quand l'appelant l'a
 * construit, se rend dessous par le même composant — un fil est un fil.
 */
function DelegationGroup({ job, deliverables }: { job: FeedChildJob; deliverables: Deliverables }) {
  const durationMs =
    job.completedAt !== null && job.createdAt !== null
      ? job.completedAt.getTime() - job.createdAt.getTime()
      : null;
  // Le fil du délégué, quand l'appelant l'a assemblé (un niveau, job-feed.ts) :
  // ses tours, ses cartes, sa réponse — SANS sa demande, qui est la consigne
  // du parent, déjà écrite sous « Task » ; un « You » y serait faux, c'est
  // l'agent parent qui a demandé.
  const nested = job.feed?.items.filter((i) => i.kind !== 'request' && i.kind !== 'history');
  const totals = job.feed?.totals;
  const aside = [
    durationMs !== null && durationMs > 0 ? formatMs(durationMs) : null,
    totals ? `${formatTokens(totals.inputTokens + totals.outputTokens)} tokens` : null,
    totals && totals.costUsd !== null ? formatCost(totals.costUsd) : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');
  return (
    <div className="mt-4 pl-[46px]">
      <DelegationDisclosure
        label={`Delegated to ${job.agentName ?? 'an agent'}`}
        avatar={<AgentAvatar name={job.agentName ?? 'Agent'} size="sm" shape="square" />}
        title={delegationTitle(job.result, job.task)}
        ok={job.status === 'completed'}
        aside={aside}
      >
        {job.task !== null && (
          <div className="px-4 py-3">
            <SectionLabel>Task</SectionLabel>
            <Markdown text={job.task} />
          </div>
        )}
        {nested !== undefined && nested.length > 0 ? (
          // Le fil du délégué porte déjà sa réponse (`answer`) ou son échec
          // (`failure`) : le résultat et l'erreur ne se répètent pas dessous.
          <div className="border-t border-rule-2 px-4 pb-3">
            <FeedItems items={nested} deliverables={deliverables} />
          </div>
        ) : (
          <>
            {job.result !== null && (
              <div className="border-t border-rule-2 px-4 py-3">
                <SectionLabel>Result</SectionLabel>
                <Markdown text={job.result} />
              </div>
            )}
            {job.error !== null && (
              <p className="border-t border-rule-2 px-4 py-3 text-body-13 text-err">{job.error}</p>
            )}
          </>
        )}
        {/* P8 : le fil d'un JOB vit sur /scheduled/[id] — /spaces/<id> est
            devenu la page d'un PROJET. */}
        <div className="border-t border-rule-2 px-4 py-2">
          <Link href={`/scheduled/${job.id}`} className="text-mono-11 text-ink-3 hover:text-ink">
            Open the run
          </Link>
        </div>
      </DelegationDisclosure>
    </div>
  );
}
