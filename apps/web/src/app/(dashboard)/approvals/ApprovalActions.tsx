'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { resolveApprovalAction, setAgentApprovalRuleAction } from '@/lib/actions.ts';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextArea from '@/components/ui/TextArea';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import Checkbox from '@/components/ui/Checkbox';

interface Props {
  approvalId: string;
  /** Tool being approved — needed to write a per-tool standing rule. */
  toolName: string;
  /** Agent that asked. Rules bind it by default, or the whole workspace on request. */
  agentId: string | null;
  /**
   * `<serveur>__*` when this call comes from an MCP server. One decision covers
   * every tool that server exposes — a server of 30 tools would otherwise need
   * 30 identical rules, and a gate nobody can express becomes a rubber stamp.
   */
  mcpRulePattern: string | null;
  /** Human name of the MCP server, for the confirmation copy. */
  mcpServerName: string | null;
}

/**
 * Decision surface for one pending approval.
 *
 * Graduated consent rather than a binary approve/reject. A gate with no memory
 * is unusable — every MCP call re-asks forever, and the owner ends up granting a
 * blanket `*` rule, which restores the ungated state while looking like
 * oversight. The ladder here is the same one agent clients converge on: once,
 * always-for-this-tool, always-for-this-server, reject, always-reject.
 *
 * "Always" writes an `approval_rules` row behind a ConfirmDialog — a standing
 * grant deserves a deliberate second gesture, not the same click as a one-off.
 * It is scoped to THIS agent by default; the dialog offers widening it to every
 * agent, because with seven MCP servers the per-agent scope turns one decision
 * into dozens of identical clicks, and that is how people reach for a blanket
 * `*` rule instead.
 */
export default function ApprovalActions({
  approvalId,
  toolName,
  agentId,
  mcpRulePattern,
  mcpServerName,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [notes, setNotes] = useState('');
  const [confirm, setConfirm] = useState<null | 'tool' | 'server' | 'block'>(null);
  // Reset on every open: a grant widened once must not silently pre-widen the next.
  const [allAgents, setAllAgents] = useState(false);

  function resolve(decision: 'approve' | 'reject', reason?: string) {
    return resolveApprovalAction({
      approvalRequestId: approvalId,
      decision,
      ...(reason ? { notes: reason } : {}),
    });
  }

  function handleApproveOnce() {
    startTransition(async () => {
      const r = await resolve('approve');
      if (!r.ok) toast.error(r.message);
      else toast.success('Approuvé, cette fois seulement.');
    });
  }

  /**
   * Write the standing rule FIRST, then resolve.
   *
   * If the order were reversed, a failure to persist the rule would leave the
   * call approved and the owner believing they had granted a standing rule that
   * does not exist — they would find out on the next prompt. This way a failed
   * rule leaves the approval pending, which is visible and retryable.
   */
  function handleAlways(scope: 'tool' | 'server') {
    const pattern = scope === 'server' ? mcpRulePattern : toolName;
    if (!agentId || !pattern) return;
    const ruleScope = allAgents ? ('entity' as const) : ('agent' as const);
    setConfirm(null);
    startTransition(async () => {
      const rule = await setAgentApprovalRuleAction({
        agentId,
        toolName: pattern,
        action: 'auto_approve',
        scope: ruleScope,
      });
      if (!rule.ok) {
        toast.error(`Règle non enregistrée : ${rule.message}. L'approbation reste en attente.`);
        return;
      }
      const scopeLabel = ruleScope === 'entity' ? 'pour tous vos agents' : 'pour cet agent';
      const r = await resolve('approve');
      if (!r.ok) toast.error(r.message);
      else {
        toast.success(
          scope === 'server'
            ? `Approuvé. Tous les outils de ${mcpServerName ?? 'ce serveur'} passeront désormais sans demande, ${scopeLabel}.`
            : `Approuvé. ${toolName} passera désormais sans demande, ${scopeLabel}.`,
        );
      }
    });
  }

  function handleBlockAlways() {
    if (!agentId) return;
    setConfirm(null);
    startTransition(async () => {
      const rule = await setAgentApprovalRuleAction({
        agentId,
        toolName,
        action: 'block',
      });
      if (!rule.ok) {
        toast.error(`Règle non enregistrée : ${rule.message}. L'approbation reste en attente.`);
        return;
      }
      const r = await resolve('reject', 'Bloqué définitivement par le propriétaire.');
      if (!r.ok) toast.error(r.message);
      else toast.success(`${toolName} est désormais bloqué pour cet agent.`);
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
        toast.success('Refusé');
        setShowRejectInput(false);
        setNotes('');
      }
    });
  }

  const canRule = Boolean(agentId);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-end gap-2">
        <PrimaryButton
          variant="ink"
          size="sm"
          onClick={handleApproveOnce}
          disabled={isPending}
          className="!bg-ok !text-xs !text-canvas hover:!brightness-[0.92]"
        >
          Approuver une fois
        </PrimaryButton>

        {canRule && mcpRulePattern && (
          <PrimaryButton
            variant="neutral"
            size="sm"
            onClick={() => {
              setAllAgents(false);
              setConfirm('server');
            }}
            disabled={isPending}
            className="!text-xs"
          >
            Toujours pour ce serveur
          </PrimaryButton>
        )}

        {canRule && (
          <PrimaryButton
            variant="neutral"
            size="sm"
            onClick={() => {
              setAllAgents(false);
              setConfirm('tool');
            }}
            disabled={isPending}
            className="!text-xs"
          >
            Toujours pour cet outil
          </PrimaryButton>
        )}

        <PrimaryButton
          variant="danger"
          size="sm"
          onClick={handleReject}
          disabled={isPending}
          className="!text-xs"
        >
          {showRejectInput ? 'Confirmer le refus' : 'Refuser'}
        </PrimaryButton>

        {canRule && !showRejectInput && (
          <PrimaryButton
            variant="neutral"
            size="sm"
            onClick={() => setConfirm('block')}
            disabled={isPending}
            className="!text-xs !text-danger"
          >
            Toujours refuser
          </PrimaryButton>
        )}

        {showRejectInput && (
          <PrimaryButton
            variant="neutral"
            size="sm"
            className="!border-0 !bg-transparent !text-ink-3 hover:!text-ink"
            onClick={() => {
              setShowRejectInput(false);
              setNotes('');
            }}
          >
            Annuler
          </PrimaryButton>
        )}
      </div>

      {showRejectInput && (
        <TextArea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Raison du refus (facultatif, transmise à l'agent)"
          rows={2}
          maxLength={500}
          className="!resize-none !bg-canvas text-xs"
        />
      )}

      <ConfirmDialog
        open={confirm === 'server'}
        title={`Toujours autoriser ${mcpServerName ?? 'ce serveur'} ?`}
        message={`Tous les outils exposés par ce serveur s'exécuteront sans demande pour cet agent, y compris ceux qu'il ajoutera plus tard. Une règle par outil peut toujours faire exception. Révocable dans les réglages de l'agent.`}
        confirmLabel="Toujours autoriser"
        destructive={false}
        extra={
          <Checkbox
            checked={allAgents}
            onChange={(e) => setAllAgents(e.target.checked)}
            label={
              <span className="text-body-13 text-ink-2">
                Pour tous mes agents, pas seulement celui-ci
              </span>
            }
          />
        }
        onConfirm={() => handleAlways('server')}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm === 'tool'}
        title={`Toujours autoriser ${toolName} ?`}
        message={`Cet outil s'exécutera sans demande pour cet agent, quels que soient ses arguments. Révocable dans les réglages de l'agent.`}
        confirmLabel="Toujours autoriser"
        destructive={false}
        extra={
          <Checkbox
            checked={allAgents}
            onChange={(e) => setAllAgents(e.target.checked)}
            label={
              <span className="text-body-13 text-ink-2">
                Pour tous mes agents, pas seulement celui-ci
              </span>
            }
          />
        }
        onConfirm={() => handleAlways('tool')}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm === 'block'}
        title={`Toujours refuser ${toolName} ?`}
        message={`Cet outil échouera immédiatement pour cet agent, sans rien demander. L'agent verra l'échec et devra faire autrement. Révocable dans les réglages de l'agent.`}
        confirmLabel="Toujours refuser"
        destructive
        onConfirm={handleBlockAlways}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
