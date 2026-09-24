'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ShieldCheck, Warning } from '@phosphor-icons/react';
import {
  resolveApprovalAction,
  setAgentApprovalRuleAction,
  setAgentShellPolicyAction,
  listApprovalsAction,
  type ApprovalRow,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
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
import { SHELL_CATEGORY_COPY } from '@/lib/shell-checklist-copy.ts';

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
 * DEUX ÉTATS, ET RIEN D'AUTRE (composant Figma « Approval Card », nœud
 * 557:6743, variantes Open 557:6742 et Close 557:6741). Open montre tout.
 * Close est la MÊME carte moins le seul bloc `request` — la ligne d'effet et
 * les arguments. La raison de l'agent, « Tool input », les règles et le pied de
 * boutons restent dans les deux : ce sont eux qui font lire et décider.
 *
 * Le pli à 100 % de #365/#368 est retiré : il inventait un troisième état que
 * le dessin ne porte pas, et il rangeait sous le même chevron une archive
 * entière d'un côté, règles et boutons de l'autre.
 *
 * Défauts : en attente → Open (elle appelle une réponse) ; tranchée → Close
 * (c'est une archive) ; `defaultOpen` → Open, ce que `?show=` demande.
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
  const [neverOpen, setNeverOpen] = useState(false);
  const [notes, setNotes] = useState('');
  // Open ou Close, les deux variantes du dessin. En attente → Open ; tranchée
  // → Close ; `defaultOpen` force Open.
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
  // Ce que la liste de l'agent a retenu ici (#464) : ce que « Never for this
  // agent » passerait à Never (#470). Une carte sans elles n'offre pas le choix.
  const neverKinds = (a.gateReasons ?? []).filter((r) => r.state === 'ask');

  if (statutVu !== a.status) {
    setStatutVu(a.status);
    setRequestOpen(pending || defaultOpen);
    setInputOpen(false);
  }

  /**
   * Passer de Open à Close. Le pli de « Tool input » est INDÉPENDANT : il a son
   * propre caret, il est replié par défaut, et il reste ce qu'il est quand la
   * carte change d'état.
   */
  function toggleRequest() {
    setRequestOpen((v) => !v);
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

  /**
   * « Never for this agent » (#470, Quentin 24/09) : refuser, ET ne plus
   * jamais le demander pour ces sortes d'action. Le réglage d'abord, la
   * réponse ensuite, comme « Approve for this project » : un réglage qui
   * n'est pas écrit laisse la demande en attente, ce qui se voit et se rejoue,
   * au lieu d'un refus qui ferait croire que la suite est réglée.
   */
  function handleNever() {
    const agentId = a.agentId;
    if (agentId === null) return;
    setNeverOpen(false);
    startTransition(async () => {
      for (const reason of neverKinds) {
        const saved = await setAgentShellPolicyAction({
          agentId,
          category: reason.category,
          state: 'never',
        });
        if (!saved.ok) {
          // Le message du serveur finit souvent par un point : pas de « .. ».
          toast.error(
            `Setting not saved: ${saved.message.replace(/\.$/, '')}. The approval stays pending.`,
          );
          return;
        }
      }
      // What the AGENT reads with the refusal (run 2fb6bfca, 24/09): a bare
      // "rejected" sent it looking for another way to the same files. The
      // note says it is a Never, on what, and not to work around it.
      const refused = neverKinds
        .map((reason) => {
          const kind = SHELL_CATEGORY_COPY[reason.category].label.toLowerCase();
          return reason.details.length > 0 ? `${kind} (${reason.details.join(', ')})` : kind;
        })
        .join('; ');
      const r = await resolve(
        'reject',
        `The owner answered Never: this agent may not ${refused}, now or later. ` +
          'Do not look for another way to do it; report what you could not do.',
      );
      if (!r.ok) toast.error(r.message);
      else toast.success(`Rejected. ${agentName} will not be asked this again: it is refused.`);
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
          {/* Le bouclier porte la couleur d'alerte du dessin (DS, token
              `color/warn`) : c'est l'objet qui signale une demande, pas une
              icône décorative. */}
          <ShieldCheck
            size={16}
            className="shrink-0 text-warn"
            aria-hidden
            data-testid="approval-shield"
          />
          <span className="truncate text-medium-14 text-ink">
            {question ? question.question : toolDisplayName(a.toolName)}
          </span>
        </div>
        {/* Le statut, et lui seul. « View job » est descendu au pied sous le
            nom « Open Run » : l'en-tête dit ce qu'on regarde, le pied dit ce
            qu'on peut en faire (dessin, nœud 557:6743). */}
        <div className="flex shrink-0 items-center gap-2">
          <StatusPill variant={STATUS_TO_VARIANT[a.status] ?? 'idle'} label={a.status} />
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
        <span className="truncate text-body-13 text-ink-3">needs to execute this tool</span>
        <span className="ml-auto shrink-0 truncate text-mono-11 text-feed-tool">{a.toolName}</span>
      </DisclosureButton>

      {/* LA RAISON, DANS LES DEUX ÉTATS. La voix de l'agent, verbatim
          (invariant #2), alignée sous le nom de l'agent. Une absence se dit :
          « il n'a pas dit pourquoi » est une information. Close cache ce que
          l'outil FERA, jamais ce que l'agent a DIT.
          38 px : l'inset de `DisclosureButton` (px-4) plus son caret (w-3.5)
          plus son gap-2, c'est-à-dire la colonne où commence le nom de
          l'agent. */}
      <div className="bg-paper py-3 pl-[38px] pr-3" data-testid="approval-reason">
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
          <p className="text-body-13 italic text-ink-2">
            {x.purpose ? `“${x.purpose}”` : 'The agent did not say why.'}
          </p>
        )}

        {/* QUAND, dans les deux états et pour les deux genres. Cette ligne
            vivait dans le bloc `request` : une QUESTION, qui n'a pas ce bloc,
            perdait alors sa date d'expiration partout (Reviewer C, C1). Une
            échéance que rien n'affiche est une échéance qui surprend. */}
        {(a.requestedAt || (pending && a.expiresAt)) && (
          <p className="pt-1.5 text-body-12 text-ink-3" data-testid="approval-timing">
            {a.requestedAt && <>requested {new Date(a.requestedAt).toLocaleString()}</>}
            {pending && a.expiresAt && (
              <> {`· expires ${new Date(a.expiresAt).toLocaleString()}`}</>
            )}
          </p>
        )}
      </div>

      {/* LE SEUL BLOC QUE « Close » CACHE : l'effet et les arguments, ce que
          l'appel va faire au monde. */}
      {question === null && requestOpen && (
        <div
          className="flex flex-col gap-1.5 bg-canvas py-2.5 pl-[38px] pr-6"
          data-testid="approval-request-body"
        >
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

          {/* Ce que la liste de l'agent a vu dans cette commande (#464) : les
              sortes d'action qui l'ont retenue. La commande elle-même est déjà
              sur la carte (les programmes lancés, puis « Tool input »). */}
          {a.gateReasons.length > 0 && (
            <ul className="flex flex-col gap-1" data-testid="approval-shell-reasons">
              {a.gateReasons.map((reason) => (
                <li key={reason.category} className="text-medium-12 text-ink">
                  {SHELL_CATEGORY_COPY[reason.category].label}
                </li>
              ))}
            </ul>
          )}

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
      )}

      {/* Les arguments bruts, repliés : ce qui a été lu plus haut est mis en
          forme, ceci est la source. Son pli lui appartient, et il survit au
          passage Open / Close. */}
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

      {/* POURQUOI cette demande existe. Sans cette section, l'ordre de
          precedence etait invisible, et la carte pouvait promettre le
          contraire de ce que la porte allait faire (#346). */}
      {question === null && (
        <div className="flex flex-col gap-2 border-t border-rule-2 px-4 pb-6 pt-4">
          <p className="text-body-13 text-ink">Reason this triggered Approval request</p>
          <div className="overflow-clip rounded-lg bg-hover" data-testid="approval-rule-list">
            {lines.map((row, i) => (
              <div
                key={row.key}
                className={`flex items-center gap-2.5 px-2.5 py-3 ${i > 0 ? 'border-t border-rule-2' : ''}`}
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
                {/* Le dessin écrit « Overriden » avec un seul r : c'est une
                    faute d'orthographe, pas un mot du produit. */}
                {row.wins ? (
                  <span className="w-25 shrink-0 text-mono-11 text-ok">Wins</span>
                ) : (
                  <span className="w-25 shrink-0 text-mono-11 text-ink-4 opacity-60">
                    Overridden
                  </span>
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
                      variant="neutral"
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

      {/* Une demande deja tranchee garde ce qui a ete decide, et par qui. */}
      {!pending && (a.notes || a.answer) && (
        <p
          className="border-t border-rule-2 px-4 py-3 text-body-12 italic text-ink-3"
          data-testid="approval-decision-note"
        >
          {a.answer ? `Answered: ${a.answer}` : `Note: ${a.notes}`}
          {a.resolvedBy ? ` (by ${a.resolvedBy})` : ''}
        </p>
      )}

      {/* LE PIED, DANS LES DEUX ETATS. A gauche « Open Run », qui mene au run
          et reste quoi qu'il arrive : une demande tranchee se relit la. A
          droite la decision, et elle seule s'en va une fois prise. Aucun bouton
          n'ecrit de regle, sauf celui qui le dit. */}
      <div className="flex flex-col gap-3 border-t border-rule-2 px-4 pb-6 pt-6.5">
        {pending && question === null && showRejectInput && (
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
          <PrimaryButton variant="neutral" size="md" href={`/jobs/${a.jobId}`}>
            Open Run
          </PrimaryButton>

          {pending &&
            (question ? (
              <QuestionActions approvalId={a.id} options={question.options} />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {/* Rejeter est plein, pas contour : c'est la seule action qui
                    coupe l'agent, et le dessin la peint en `color/skill`. La
                    variante `danger` du DS est un contour, partagee par les
                    « Disconnect » de modale ; on surcharge ici plutot que de
                    repeindre tous les autres. */}
                <PrimaryButton
                  variant="danger"
                  size="md"
                  className="!border-skill !bg-skill !text-canvas hover:!bg-skill hover:!brightness-95"
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
                {a.agentId !== null && neverKinds.length > 0 && (
                  <PrimaryButton
                    variant="neutral"
                    size="md"
                    onClick={() => setNeverOpen(true)}
                    disabled={isPending}
                    data-testid="approval-never"
                  >
                    Never for this agent
                  </PrimaryButton>
                )}
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
                  className="!bg-ok !text-paper"
                  onClick={handleApproveOnce}
                  disabled={isPending}
                  data-testid="approval-approve-once"
                >
                  Approve once
                </PrimaryButton>
              </div>
            ))}
        </div>
      </div>

      <ConfirmDialog
        open={neverOpen}
        title={`Never allow this for ${agentName}?`}
        message="This request is rejected, and from now on these are refused without asking you."
        extra={
          <ul className="flex flex-col gap-1" data-testid="approval-never-changes">
            {neverKinds.map((reason) => (
              <li key={reason.category} className="text-body-13 text-ink-2">
                {SHELL_CATEGORY_COPY[reason.category].label}: Ask me → Never
              </li>
            ))}
          </ul>
        }
        confirmLabel="Set to Never and reject"
        destructive
        onConfirm={handleNever}
        onCancel={() => setNeverOpen(false)}
      />
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
