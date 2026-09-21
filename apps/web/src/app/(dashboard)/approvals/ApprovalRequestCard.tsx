'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ShieldCheck, Warning } from '@phosphor-icons/react';
import {
  resolveApprovalAction,
  setAgentApprovalRuleAction,
  listApprovalsAction,
  type ApprovalRow,
} from '@/lib/actions.ts';
import { readQuestionToolInput, toolDisplayName } from '@nodal-agents/shared';
import type { ExplainedApprovalRule } from '@nodal-agents/shared';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextArea from '@/components/ui/TextArea';
import Select from '@/components/ui/Select';
import SegmentedControl from '@/components/ui/SegmentedControl';
import StatusPill from '@/components/ui/StatusPill';
import type { StatusVariant } from '@/components/ui/StatusPill';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import AgentAvatar from '@/components/ui/AgentAvatar';
import DisclosureButton from '@/components/ui/DisclosureButton';
import QuestionActions from './QuestionActions.tsx';
import { useApprovals } from '@/components/ApprovalsProvider';

type RuleAction = 'auto_approve' | 'require_approval' | 'block';

const ACTION_TAG: Record<RuleAction, { label: string; tone: 'ok' | 'warn' | 'err' }> = {
  auto_approve: { label: 'Autonomous', tone: 'ok' },
  require_approval: { label: 'Ask first', tone: 'warn' },
  block: { label: 'Block', tone: 'err' },
};

const STATUS_TO_VARIANT: Record<string, StatusVariant> = {
  pending: 'run',
  approved: 'done',
  rejected: 'warn',
  expired: 'idle',
};

/**
 * One approval request, in full — the same card on `/approvals` and inside a
 * code process, because two renderings of the same decision drift (the Code tab
 * used to show a shorter one, in French).
 *
 * WHAT CHANGED, AND WHY (issue #346). The card used to offer a ladder of
 * "Always…" buttons. Answering wrote a rule, and the confirmation announced a
 * permission the gate did not grant: a more specific rule kept asking, and
 * nothing on screen named it. So:
 *
 *   - the card SHOWS the rules that decided this call, in the gate's own order,
 *     with the winner marked (`explainApprovalRules`, the function the gate
 *     derives from — one truth);
 *   - a rule changes only through its own line ("Change"), never as a side
 *     effect of answering;
 *   - the one exception is "Approve for this project", which is a narrower
 *     grant than any "Always": this tool, this agent, WHILE IT WORKS IN THIS
 *     FOLDER.
 *
 * Changing a rule does NOT answer the request. The person then approves or
 * rejects, which is the whole point: they can see what they changed before
 * living with it.
 *
 * LE PLI (Quentin, 21/09). Une demande en attente s'ouvre : elle attend une
 * réponse, donc tout ce qui sert à décider est visible, « Tool input » mis à
 * part. Une demande tranchée est une archive : elle tient sur deux lignes, et
 * son caret rouvre la carte entière. `defaultOpen` est la seule exception, et
 * elle vient de la page, jamais de l'URL lue ici.
 */
export default function ApprovalRequestCard({
  approval,
  onResolved,
  defaultOpen = false,
}: {
  approval: ApprovalRow;
  /** Called after a successful answer, so a list can drop the card. */
  onResolved?: () => void;
  /**
   * Ouvrir une demande DÉJÀ TRANCHÉE malgré le pli par défaut. C'est ce que
   * `?show=<id>` demande : la personne a cliqué sur cette demande précise dans
   * RECENTS, elle veut la lire, pas la déplier. La page le dit explicitement ;
   * la carte ne lit jamais l'URL elle-même.
   */
  defaultOpen?: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [notes, setNotes] = useState('');
  // LE PLI SUIT L'ÉTAT DE LA DEMANDE (Quentin, 21/09). Une demande en attente
  // s'ouvre : elle appelle une réponse, tout ce qui sert à décider est sous les
  // yeux. Une demande tranchée est une archive : elle se range à une ligne, et
  // le caret la rouvre entière.
  const [requestOpen, setRequestOpen] = useState(approval.status === 'pending' || defaultOpen);
  // LE STATUT DÉJÀ VU. La page garde la MÊME carte quand elle se relit après une
  // réponse (même `key`), et l'onglet All la garde en liste : sans cela, une
  // demande qui vient d'être tranchée restait dépliée au milieu de voisines
  // rangées (Reviewer C, passe 1). Ajusté au rendu plutôt que dans un effet,
  // pour qu'aucune image ne montre l'ancien pli.
  const [statutVu, setStatutVu] = useState(approval.status);
  const [inputOpen, setInputOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [chain, setChain] = useState<ExplainedApprovalRule[]>(approval.ruleChain);
  const [folder, setFolder] = useState<string>(approval.agentWorkspaces[0]?.path ?? '');
  const { refresh } = useApprovals();

  const a = approval;
  const question = a.kind === 'question' ? readQuestionToolInput(a.toolInput) : null;
  const x = a.explanation;
  const pending = a.status === 'pending';
  const agentName = a.agentName ?? 'no agent';
  /**
   * Carte repliée à 100 % : il ne reste que l'en-tête et la ligne d'agent.
   *
   * Le caret ne replie QUE le bloc de demande sur une demande en attente — le
   * pied de boutons et les règles doivent rester joignables tant qu'il y a
   * quelque chose à répondre. Sur une demande tranchée, il n'y a plus rien à
   * répondre : le même caret range alors la carte entière.
   */
  const folded = !pending && !requestOpen;

  if (statutVu !== a.status) {
    setStatutVu(a.status);
    setRequestOpen(pending || defaultOpen);
    setInputOpen(false);
  }

  /**
   * Plier ou déplier. Replier une carte TRANCHÉE la range entièrement, « Tool
   * input » compris : un pli annoncé à 100 % qui garderait un bloc ouvert sous
   * lui le rouvrirait au clic suivant, sans que rien ne l'ait demandé.
   */
  function toggleRequest() {
    const next = !requestOpen;
    setRequestOpen(next);
    if (!next && !pending) setInputOpen(false);
  }

  /**
   * Repondre, PUIS relire les attentes — la barre compte les lignes de ce
   * provider et rien d'autre, donc repondre ici doit la faire relire, sinon le
   * nombre reste affiche jusqu'au prochain sondage (PR #339).
   */
  async function resolve(decision: 'approve' | 'reject', reason?: string) {
    const result = await resolveApprovalAction({
      approvalRequestId: a.id,
      decision,
      ...(reason ? { notes: reason } : {}),
    });
    if (result.ok) {
      await refresh();
      onResolved?.();
    }
    return result;
  }

  /** Relire la chaine apres avoir change une regle : la carte doit se croire. */
  async function reloadChain(): Promise<boolean> {
    const fresh = await listApprovalsAction({ status: 'all', jobIds: [a.jobId] });
    const row = fresh.ok ? fresh.data.find((r) => r.id === a.id) : undefined;
    if (!row) {
      // Fail loud (invariant #4). La lecture est plafonnee a 100 lignes par
      // job : au-dela, la demande regardee sort de la fenetre et la carte
      // garderait une chaine perimee en se taisant.
      toast.error('Rule saved, but the card could not re-read the rules. Reload the page.');
      return false;
    }
    setChain(row.ruleChain);
    return true;
  }

  function handleApproveOnce() {
    startTransition(async () => {
      const r = await resolve('approve');
      if (!r.ok) toast.error(r.message);
      else toast.success('Approved, this time only.');
    });
  }

  /**
   * La regle d'abord, la reponse ensuite. Dans l'autre ordre, une ecriture qui
   * echoue laisserait l'appel approuve et la personne convaincue d'avoir pose
   * une regle qui n'existe pas. Ainsi, une regle non ecrite laisse la demande
   * en attente, ce qui se voit et se rejoue.
   */
  function handleApproveForProject() {
    if (!a.agentId || folder === '') return;
    startTransition(async () => {
      const rule = await setAgentApprovalRuleAction({
        agentId: a.agentId,
        toolName: a.toolName,
        action: 'auto_approve',
        scope: 'agent',
        workspacePath: folder,
      });
      if (!rule.ok) {
        toast.error(`Rule not saved: ${rule.message}. The approval stays pending.`);
        return;
      }
      const label = a.agentWorkspaces.find((w) => w.path === folder)?.label ?? folder;
      const r = await resolve('approve');
      if (!r.ok) toast.error(r.message);
      else toast.success(`Approved. ${a.toolName} now runs without asking in ${label}.`);
    });
  }

  function handleReject() {
    if (!showRejectInput) {
      setShowRejectInput(true);
      return;
    }
    startTransition(async () => {
      const r = await resolve('reject', notes.trim() || undefined);
      if (!r.ok) toast.error(r.message);
      else {
        toast.success('Rejected');
        setShowRejectInput(false);
        setNotes('');
      }
    });
  }

  /**
   * Changer une regle. `scope` suit la ligne : une ligne d'agent ecrit une
   * regle d'agent, une ligne Everyone une regle d'entite. La ligne « Tool
   * default » n'est pas une regle : la changer en CREE une, pour cet agent.
   */
  function handleRuleChange(row: RuleLine, next: RuleAction) {
    if (!a.agentId) return;
    startTransition(async () => {
      const result = await setAgentApprovalRuleAction({
        agentId: a.agentId,
        toolName: row.toolName,
        action: next,
        scope: row.scope,
        // LA CONDITION DE DOSSIER SURVIT AU CHANGEMENT. Sans ce renvoi, passer
        // une regle « approuve dans ce dossier » a Autonomous la rendait
        // GLOBALE pour l'agent, en silence : une permission posee comme
        // « seulement ici » s'appliquait partout (revue Reviewer C, passe 1).
        ...(row.workspacePath === null ? {} : { workspacePath: row.workspacePath }),
      });
      if (!result.ok) {
        toast.error(`Rule not saved: ${result.message}`);
        return;
      }
      setEditing(null);
      if (await reloadChain()) toast.success('Rule saved. Now answer this request.');
    });
  }

  const lines: RuleLine[] = buildRuleLines(chain, agentName, a.toolName, a.toolDefault);

  return (
    <div
      className="overflow-clip rounded-xl border border-rule-2 bg-paper"
      data-testid="approval-card"
    >
      {/* Ce qui est demande, et ou aller le voir tourner. */}
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <ShieldCheck size={16} className="shrink-0 text-ink-3" aria-hidden />
          <span className="truncate text-medium-14 text-ink">
            {question ? question.question : toolDisplayName(a.toolName)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!pending && (
            <StatusPill variant={STATUS_TO_VARIANT[a.status] ?? 'idle'} label={a.status} />
          )}
          <PrimaryButton variant="neutral" size="md" href={`/jobs/${a.jobId}`}>
            View job
          </PrimaryButton>
        </div>
      </div>

      {/* Qui demande, et quel outil exactement. */}
      <DisclosureButton
        open={requestOpen}
        onClick={toggleRequest}
        className="h-11 border-t border-rule-2"
        testId="approval-request-toggle"
      >
        <AgentAvatar name={agentName} size="sm" shape="square" />
        <span className="shrink-0 text-medium-13 text-ink">{agentName}</span>
        <span className="truncate text-body-13 text-ink-3">requested use of</span>
        <span className="ml-auto shrink-0 truncate text-mono-11 text-feed-tool">{a.toolName}</span>
      </DisclosureButton>

      {requestOpen && (
        <div
          className="flex flex-col gap-4 bg-canvas px-6 py-2.5"
          data-testid="approval-request-body"
        >
          {question ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-body-13 italic text-ink-2">{question.question}</p>
              {question.context && <p className="text-body-12 text-ink-2">{question.context}</p>}
              <ul className="flex flex-col gap-0.5">
                {question.options.map((o) => (
                  <li key={o} className="text-body-12 text-ink-2">
                    {o}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              {/* La voix de l'agent, verbatim (invariant #2). Une absence se
                  dit : « il n'a pas dit pourquoi » est une information. */}
              <p className="text-body-13 italic text-ink-2">
                {x.purpose ? `“${x.purpose}”` : 'The agent did not say why.'}
              </p>

              <div className="flex flex-col gap-1.5">
                <p className="flex items-start gap-1.5 text-body-12 text-warn">
                  <Warning size={14} className="mt-0.5 shrink-0" aria-hidden />
                  <span>
                    {x.effectLabel}
                    {x.provenance.kind === 'mcp' && (
                      <>
                        {' · third-party tool, MCP server '}
                        {x.provenance.name ?? x.provenance.slug}
                      </>
                    )}
                    {x.provenance.kind !== 'mcp' && x.impact && (
                      <span className="text-ink-2">{` · ${x.impact}`}</span>
                    )}
                    {x.target && <span className="text-ink-2">{` · ${x.target}`}</span>}
                  </span>
                </p>

                {x.provenance.kind === 'mcp' && x.provenance.supplied && (
                  <p className="text-micro-10 text-ink-3">
                    Description supplied by this server, third-party text, unverified:{' '}
                    <span className="text-ink-2">{x.provenance.supplied}</span>
                  </p>
                )}

                {x.args.length > 0 && (
                  <dl className="flex flex-col gap-0.5">
                    {x.args.map((arg) => (
                      <div key={arg.key} className="flex gap-2">
                        <dt className="shrink-0 text-mono-12 text-ink-3">{arg.key}</dt>
                        <dd className="min-w-0 whitespace-pre-wrap break-all text-mono-12 text-run">
                          {arg.value}
                          {arg.truncated && (
                            <span className="text-ink-3">
                              {` (${arg.fullLength} characters, 300 shown)`}
                            </span>
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </>
          )}

          <p className="text-body-12 text-ink-3">
            {a.requestedAt && <>requested {new Date(a.requestedAt).toLocaleString()}</>}
            {pending && a.expiresAt && (
              <> {`· expires ${new Date(a.expiresAt).toLocaleString()}`}</>
            )}
          </p>
        </div>
      )}

      {/* Les arguments bruts, replies : ce qui a ete lu plus haut est mis en
          forme, ceci est la source. */}
      {!folded && (
        <div className="border-t border-rule-2">
          <DisclosureButton
            open={inputOpen}
            onClick={() => setInputOpen((v) => !v)}
            inset="tight"
            testId="approval-tool-input-toggle"
          >
            <span className="text-body-13 text-ink-3">Tool input</span>
          </DisclosureButton>
          {inputOpen && (
            <pre className="whitespace-pre-wrap break-words px-4 pb-4 text-mono-12 text-ink-2">
              {JSON.stringify(a.toolInput, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* POURQUOI cette demande existe. Sans cette section, l'ordre de
          precedence etait invisible, et la carte pouvait promettre le
          contraire de ce que la porte allait faire (#346). */}
      {question === null && !folded && (
        <div className="flex flex-col gap-4 border-t border-rule-2 p-4">
          <p className="text-mono-11 text-ink">Reason this triggered Approval request</p>
          <div className="overflow-clip rounded-lg bg-hover" data-testid="approval-rule-list">
            {lines.map((row, i) => (
              <div
                key={row.key}
                className={`flex items-center gap-2.5 px-2.5 py-3 ${i > 0 ? 'border-t border-rule' : ''}`}
                data-testid={`approval-rule-${row.key}`}
              >
                <div className={`w-25 shrink-0 ${row.wins ? '' : 'opacity-60'}`}>
                  <MonoMicroTag tone={ACTION_TAG[row.action].tone}>
                    {ACTION_TAG[row.action].label}
                  </MonoMicroTag>
                </div>
                <span className="w-25 shrink-0 text-body-12 text-ink">{row.scopeLabel}</span>
                <span
                  className={`min-w-0 flex-1 truncate text-mono-11 text-feed-tool ${row.wins ? '' : 'opacity-60'}`}
                >
                  {row.toolName}
                </span>
                {row.wins ? (
                  <span className="shrink-0 text-micro-10 text-ok">wins</span>
                ) : (
                  <span className="shrink-0 text-micro-10 text-ink-4 opacity-60">overridden</span>
                )}
                {a.agentId !== null &&
                  (editing === row.key ? (
                    <SegmentedControl
                      value={row.action}
                      onChange={(next) => handleRuleChange(row, next)}
                      disabled={isPending}
                      ariaLabel={`Approval policy for ${row.toolName}`}
                      options={[
                        {
                          value: 'auto_approve' as const,
                          label: 'Autonomous',
                          activeClassName:
                            'bg-agent-vivid/15 text-agent-vivid border-agent-vivid/30',
                          testId: `approval-rule-${row.key}-auto_approve`,
                        },
                        {
                          value: 'require_approval' as const,
                          label: 'Ask first',
                          activeClassName: 'bg-warn/15 text-warn border-warn/30',
                          testId: `approval-rule-${row.key}-require_approval`,
                        },
                        {
                          value: 'block' as const,
                          label: 'Block',
                          activeClassName: 'bg-err/15 text-err border-err/30',
                          testId: `approval-rule-${row.key}-block`,
                        },
                      ]}
                    />
                  ) : (
                    <PrimaryButton
                      variant="ink"
                      size="sm"
                      onClick={() => setEditing(row.key)}
                      disabled={isPending}
                      data-testid={`approval-rule-${row.key}-change`}
                    >
                      Change
                    </PrimaryButton>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* La decision. Aucun bouton n'ecrit de regle, sauf celui qui le dit. */}
      {pending && (
        <div className="flex flex-col gap-3 border-t border-rule-2 px-4 pb-6 pt-6.5">
          {question ? (
            <QuestionActions approvalId={a.id} options={question.options} />
          ) : (
            <>
              {showRejectInput && (
                <TextArea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Reason for rejecting (optional, passed to the agent)"
                  rows={2}
                  maxLength={500}
                  className="!resize-none !bg-canvas"
                />
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <PrimaryButton
                    variant="danger"
                    size="md"
                    onClick={handleReject}
                    disabled={isPending}
                  >
                    {showRejectInput ? 'Confirm rejection' : 'Reject'}
                  </PrimaryButton>
                  {showRejectInput && (
                    <PrimaryButton
                      variant="neutral"
                      size="md"
                      className="!border-0 !bg-transparent !text-ink-3 hover:!text-ink"
                      onClick={() => {
                        setShowRejectInput(false);
                        setNotes('');
                      }}
                    >
                      Cancel
                    </PrimaryButton>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {a.agentId !== null && a.agentWorkspaces.length > 1 && (
                    <Select
                      value={folder}
                      onChange={(e) => setFolder(e.target.value)}
                      aria-label="Folder this approval applies to"
                      data-testid="approval-folder-select"
                    >
                      {a.agentWorkspaces.map((w) => (
                        <option key={w.path} value={w.path}>
                          {w.label}
                        </option>
                      ))}
                    </Select>
                  )}
                  {a.agentId !== null && a.agentWorkspaces.length > 0 && (
                    <PrimaryButton
                      variant="neutral"
                      size="md"
                      onClick={handleApproveForProject}
                      disabled={isPending}
                      data-testid="approval-approve-project"
                    >
                      Approve for this project
                    </PrimaryButton>
                  )}
                  <PrimaryButton
                    variant="ink"
                    size="md"
                    onClick={handleApproveOnce}
                    disabled={isPending}
                    data-testid="approval-approve-once"
                  >
                    Approve once
                  </PrimaryButton>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Une demande deja tranchee garde ce qui a ete decide, et par qui. */}
      {!folded && !pending && (a.notes || a.answer) && (
        <p
          className="border-t border-rule-2 px-4 py-3 text-body-12 italic text-ink-3"
          data-testid="approval-decision-note"
        >
          {a.answer ? `Answered: ${a.answer}` : `Note: ${a.notes}`}
          {a.resolvedBy ? ` (by ${a.resolvedBy})` : ''}
        </p>
      )}
    </div>
  );
}

// ─── Les lignes de regles ─────────────────────────────────────────────────────

interface RuleLine {
  key: string;
  toolName: string;
  action: RuleAction;
  scope: 'agent' | 'entity';
  scopeLabel: string;
  /** Le dossier auquel la regle est confinee, renvoye tel quel a l'ecriture. */
  workspacePath: string | null;
  wins: boolean;
}

/**
 * La chaine telle qu'elle s'affiche, et la ligne « Tool default » quand aucune
 * regle ne nomme cet appel.
 *
 * Cette derniere n'est PAS une regle : c'est la posture propre de l'outil. La
 * changer cree une regle d'agent sur l'outil exact — ce que la ligne dit deja
 * en portant ce nom d'outil.
 */
export function buildRuleLines(
  chain: ExplainedApprovalRule[],
  agentName: string,
  toolName: string,
  toolDefault: RuleAction,
): RuleLine[] {
  if (chain.length === 0) {
    return [
      {
        key: 'tool-default',
        toolName,
        action: toolDefault,
        scope: 'agent',
        scopeLabel: 'Tool default',
        workspacePath: null,
        wins: true,
      },
    ];
  }
  return chain.map((r) => ({
    key: r.id,
    toolName: r.toolName,
    action: r.action,
    scope: r.scope,
    workspacePath: r.workspacePath,
    scopeLabel:
      r.scope === 'entity'
        ? 'Everyone'
        : r.workspaceLabel
          ? `${agentName} · in ${r.workspaceLabel}`
          : agentName,
    wins: r.wins,
  }));
}
