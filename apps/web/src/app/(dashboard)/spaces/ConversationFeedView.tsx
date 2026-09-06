// ConversationFeedView — le fil dessiné (P2, plan « De la maquette au
// produit »). Rendu côté serveur depuis `ConversationFeed` ; dispatche sur la
// CARTE persistée par P1 (`presented.card`), jamais sur le nom de l'outil. Ce
// qu'il ne sait pas dessiner, il le montre brut et le dit.

import Link from 'next/link';
import AgentAvatar from '@/components/ui/AgentAvatar';
import Disc from '@/components/ui/Disc';
import { User } from '@phosphor-icons/react/dist/ssr';
import ClampedText from './ClampedText.tsx';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import Table, { THead, Th, Tr, Td } from '@/components/ui/Table';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import type { CardPayloadFor, TableEntry } from '@nodal-agents/shared';
import { readQuestionToolInput } from '@nodal-agents/shared';
import type { DeliverableStatusView } from '@/lib/verification-runs-view.ts';
import type {
  ConversationFeed,
  FeedChildJob,
  FeedItem,
  Step,
  TurnBlock,
} from '@/lib/conversation-feed.ts';
import StepsGroup from './StepsGroup.tsx';
import ProducedCard from './ProducedCard.tsx';
import QuestionCard from './QuestionCard.tsx';
import FileDiff from './FileDiff.tsx';
import HistoryGroup from './HistoryGroup.tsx';
import { formatCost, formatMs, formatTokens, originLabel } from './format.ts';

type ToolStep = Extract<Step, { kind: 'tool' }>;

/**
 * P12 — l'état de vérification des documents du fil, rangé par clé canonique.
 * Vide par défaut : un appelant qui ne le passe pas obtient des cartes SANS
 * ligne de vérification, jamais une ligne inventée.
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
  const byKey: Deliverables = new Map(deliverables.map((d) => [d.canonicalKey, d.status]));
  return (
    <div className="mx-auto max-w-[840px]">
      {feed.items.map((item, i) => (
        <FeedItemView key={i} item={item} deliverables={byKey} />
      ))}
    </div>
  );
}

function FeedItemView({ item, deliverables }: { item: FeedItem; deliverables: Deliverables }) {
  switch (item.kind) {
    case 'request':
      return (
        <Turn
          avatar={
            <Disc variant="ink" size="sm" shape="square" aria-hidden>
              <User weight="bold" />
            </Disc>
          }
        >
          <Who name="You" meta={originLabel(item.origin)} />
          <ClampedText text={item.text} className="max-w-[68ch] text-body-15 text-ink" />
        </Turn>
      );
    case 'note':
      return (
        <p className="mt-3 truncate pl-[44px] text-mono-11 text-ink-4" title={item.text}>
          Nodal reminded the agent · {item.text}
        </p>
      );
    case 'turn':
      return (
        <Turn avatar={<AgentAvatar name={item.agent.name ?? 'Agent'} size="md" shape="square" />}>
          <Who
            name={item.agent.name ?? 'Agent'}
            meta={[
              item.model,
              item.usage
                ? `${formatTokens(item.usage.inputTokens + item.usage.outputTokens)} tokens`
                : null,
              item.usage && item.usage.durationMs > 0 ? formatMs(item.usage.durationMs) : null,
              item.usage && item.usage.costUsd !== null ? formatCost(item.usage.costUsd) : null,
            ]
              .filter((x): x is string => x !== null)
              .join(' · ')}
          />
          {item.blocks.map((b, i) => (
            <Block key={i} block={b} deliverables={deliverables} />
          ))}
          {item.blocks.length === 0 && (
            <p className="text-body-12 italic text-ink-4">No visible action this turn.</p>
          )}
        </Turn>
      );
    case 'history':
      return <HistoryGroup exchanges={item.exchanges} />;
    case 'child':
      return <ChildCard job={item.job} />;
    case 'answer':
      return (
        <div className="mt-6 max-w-[760px] rounded-xl border border-rule-2 bg-paper p-4">
          <p className="mb-1 text-label-11 uppercase tracking-wider text-ink-4">Answer</p>
          <p className="whitespace-pre-wrap text-body-15 text-ink">{item.text}</p>
        </div>
      );
    case 'produced':
      // P7 — ce qui est sorti du chat à ce tour. Il ne paraît QUE là :
      // `buildConversationThread` ne pose l'item que sur un tour qui a produit.
      return <ProducedCard verdict={item.verdict} project={item.project} />;
    case 'handoff':
      // P7 — la consigne passée au travail. Repliée dans le style des notes :
      // la demande de l'utilisateur est juste au-dessus, écrite de sa main.
      return (
        <p className="mt-3 truncate pl-[44px] text-mono-11 text-ink-4" title={item.text}>
          Handed to the work · {item.text}
        </p>
      );
    case 'failure':
      return (
        <div className="mt-6 max-w-[760px] rounded-xl border border-err/30 bg-warn-bg p-4">
          <p className="mb-1 text-label-11 uppercase tracking-wider text-err">Failed</p>
          <p className="whitespace-pre-wrap text-body-13 text-err">{item.text}</p>
        </div>
      );
  }
}

function Turn({ avatar, children }: { avatar: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[30px_1fr] gap-[14px] pt-6">
      <div>{avatar}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Who({ name, meta }: { name: string; meta: string }) {
  return (
    <div className="mb-1.5 flex items-baseline gap-2">
      <span className="text-medium-14 text-ink">{name}</span>
      {meta !== '' && <span className="text-mono-11 text-ink-4">{meta}</span>}
    </div>
  );
}

function Block({ block, deliverables }: { block: TurnBlock; deliverables: Deliverables }) {
  switch (block.kind) {
    case 'prose':
      return (
        <p className="mb-3 max-w-[68ch] whitespace-pre-wrap text-body-15 text-ink-2">
          {block.text}
        </p>
      );
    case 'steps':
      return (
        <div className="mb-3">
          <StepsGroup steps={block.steps} />
        </div>
      );
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
      return <QuestionCard prompt={prompt} options={options} question={step.question} />;
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
  const foot = [
    entry.truncated ? `showing ${entry.rows.length} of ${entry.total} rows` : null,
    entry.clipped ? 'some cells were shortened' : null,
    entry.header === 'unknown' ? 'first row may or may not be a header' : null,
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
  not_configured: 'Not verified: no checks exist for documents yet',
  dirty: 'Not yet verified',
  pending_approval: 'Checks await approval',
  green: 'Verified',
  red: 'Checks failed',
  infra_error: 'Checks could not run',
};

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
      <TableBody
        entry={entry}
        notes={[
          ...(entry.total === 0 ? ['empty sheet'] : []),
          'values only: no formulas, formatting or merged cells',
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
  return (
    <CardFrame
      title={`${payload.total} ${payload.total === 1 ? 'file' : 'files'}`}
      meta={payload.truncated ? `showing ${payload.files.length}` : undefined}
      aside={aside}
    >
      <ul className="py-1">
        {payload.files.map((f, i) => {
          // P12 — l'aperçu se pose SOUS la ligne du fichier, au-dessus du diff
          // de P11. L'état de vérification ne se lit que si l'outil a écrit la
          // clé du livrable ET que le fil porte une ligne pour elle.
          const preview =
            f.preview === undefined ? undefined : (
              <FilePreview
                entry={f.preview}
                status={
                  f.deliverableKey === undefined ? undefined : deliverables.get(f.deliverableKey)
                }
              />
            );
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
                {...(f.bytes !== undefined ? { bytes: `${formatTokens(f.bytes)} B` } : {})}
                {...(f.detail !== undefined ? { detail: f.detail } : {})}
                {...(preview !== undefined ? { preview } : {})}
              />
            );
          }
          return (
            <li key={i} className="text-mono-12 text-ink-2">
              <div className="flex items-center gap-3 px-4 py-1.5">
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                <MonoMicroTag tone={f.action === 'listed' ? 'ink' : 'agent'}>
                  {f.action}
                </MonoMicroTag>
                {f.bytes !== undefined && (
                  <span className="text-ink-4">{formatTokens(f.bytes)} B</span>
                )}
                {f.detail !== undefined && <span className="truncate text-ink-4">{f.detail}</span>}
              </div>
              {preview}
            </li>
          );
        })}
      </ul>
    </CardFrame>
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
        <p className="whitespace-pre-wrap px-4 py-3 text-body-13 text-ink-2">{text}</p>
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
      <p className="whitespace-pre-wrap px-4 py-3 text-body-13 text-ink-2">{payload.summary}</p>
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

function DelegationCard({ payload }: { payload: CardPayloadFor<'delegation'> }) {
  return (
    <CardFrame
      title={`Delegated to ${payload.to}`}
      meta={[
        payload.durationMs !== null ? formatMs(payload.durationMs) : null,
        payload.costUsd !== null ? formatCost(payload.costUsd) : null,
      ]
        .filter((x): x is string => x !== null)
        .join(' · ')}
      aside={
        <MonoMicroTag tone={payload.ok ? 'agent' : 'err'}>
          {payload.ok ? 'done' : 'failed'}
        </MonoMicroTag>
      }
      tone={payload.ok ? 'neutral' : 'warn'}
    >
      <p className="px-4 pt-3 text-label-11 uppercase tracking-wider text-ink-4">Task</p>
      <p className="whitespace-pre-wrap px-4 pb-3 text-body-13 text-ink-3">{payload.task}</p>
      {payload.resultText !== null && (
        <>
          <p className="border-t border-rule-2 px-4 pt-3 text-label-11 uppercase tracking-wider text-ink-4">
            Result
          </p>
          <p className="whitespace-pre-wrap px-4 pb-3 text-body-13 text-ink-2">
            {payload.resultText}
          </p>
        </>
      )}
      {payload.error !== null && (
        <p className="border-t border-rule-2 px-4 py-3 text-body-13 text-err">{payload.error}</p>
      )}
    </CardFrame>
  );
}

function statusVariant(status: string | null): StatusVariant {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'warn';
  if (status === 'processing' || status === 'pending' || (status?.startsWith('awaiting') ?? false))
    return 'run';
  return 'idle';
}

function ChildCard({ job }: { job: FeedChildJob }) {
  return (
    <div className="mt-4 pl-[44px]">
      {/* P8 : le fil d'un JOB vit sur /scheduled/[id] — /spaces/<id> est
          devenu la page d'un PROJET. Sans ce changement, ouvrir une délégation
          depuis le fil tombait sur « projet introuvable ». */}
      <Link
        href={`/scheduled/${job.id}`}
        className="flex max-w-[760px] items-center gap-3 rounded-xl border border-rule-2 bg-paper px-4 py-3 hover:border-rule"
      >
        <AgentAvatar name={job.agentName ?? 'Agent'} size="sm" shape="square" />
        <span className="text-medium-13 text-ink">Delegated to {job.agentName ?? 'an agent'}</span>
        <StatusPill variant={statusVariant(job.status)} />
        <span className="min-w-0 flex-1 truncate text-body-12 text-ink-3">
          {job.result ?? job.error ?? job.task ?? ''}
        </span>
      </Link>
    </div>
  );
}
