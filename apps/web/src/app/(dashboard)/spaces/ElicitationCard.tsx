'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { PlugsConnected } from '@phosphor-icons/react';
import {
  elicitationActionLabels,
  parseElicitationSchema,
  validateElicitationContent,
  type ElicitationField,
} from '@nodal-agents/shared';
import { resolveApprovalAction } from '@/lib/actions.ts';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextInput from '@/components/ui/TextInput';
import Select from '@/components/ui/Select';
import Switch from '@/components/ui/Switch';
import Checkbox from '@/components/ui/Checkbox';
import FieldLabel from '@/components/ui/FieldLabel';
import { useApprovals } from '@/components/ApprovalsProvider';
import {
  attachmentHref,
  describeAnswerValue,
  expiredReason,
  formStateToContent,
  initialFormState,
  type ElicitationFormState,
  type ElicitationFormValue,
  type ElicitationView,
} from '@/lib/elicitation-view.ts';

export interface ElicitationCardProps {
  elicitation: ElicitationView;
  /** Appelé après une réponse acceptée par le runner (la page Approvals retire la carte). */
  onResolved?: () => void;
}

/**
 * La carte d'une question posée par un SERVEUR MCP pendant un de ses appels
 * (élicitation, PR 2 de l'hôte MCP). La même dans le fil du run, sur la page
 * Approvals et derrière la cloche.
 *
 * Ce n'est PAS une approbation : rien ici n'écrit de règle, rien ne dit
 * « Approve ». Le serveur demande un formulaire ; la personne l'envoie ou le
 * refuse. « Annuler » n'est jamais un clic : c'est ce que le runner répond
 * quand le temps passe, quand le run s'arrête ou quand le serveur retire sa
 * question.
 *
 * Le message du serveur est un texte TIERS : cité tel quel, en texte brut,
 * jamais rendu en markdown ni en HTML. Le cadre, lui, est celui du produit.
 *
 * Les images jointes (`_meta["nodal/attachments"]`) sont lues par leur route,
 * qui vérifie la session : jamais d'octets dans la page.
 */
export default function ElicitationCard({ elicitation, onResolved }: ElicitationCardProps) {
  const e = elicitation;
  const router = useRouter();
  const { refresh } = useApprovals();
  const [isPending, startTransition] = useTransition();
  const parsed = useMemo(() => parseElicitationSchema(e.requestedSchema), [e.requestedSchema]);
  const fields: ElicitationField[] = parsed.ok ? parsed.fields : [];
  const [state, setState] = useState<ElicitationFormState>(() => initialFormState(fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const waiting = e.status === 'pending';
  // Ce que les boutons FONT, aux mots du serveur (« Print ») ; sinon
  // « ✅ Confirm » / « Decline ». Jamais « Send » : il ne disait pas ce qui
  // allait se passer (retour du propriétaire, 01/10).
  const labels = elicitationActionLabels(e.actions);

  function set(key: string, value: ElicitationFormValue) {
    setState((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function after() {
    router.refresh();
    await refresh();
    onResolved?.();
  }

  function send() {
    const content = formStateToContent(fields, state);
    // La même règle que le runner, AVANT l'aller-retour : la personne lit
    // l'erreur sous le champ. Le runner la refait et c'est lui qui décide.
    const checked = validateElicitationContent(fields, content);
    if (!checked.ok) {
      const byField: Record<string, string> = {};
      const general: string[] = [];
      for (const err of checked.errors) {
        if (err.field && !byField[err.field]) byField[err.field] = err.reason;
        else if (!err.field) general.push(err.reason);
      }
      setErrors(byField);
      setFormError(general.length > 0 ? general.join('; ') : null);
      return;
    }
    setErrors({});
    setFormError(null);
    startTransition(async () => {
      const r = await resolveApprovalAction({
        approvalRequestId: e.approvalRequestId,
        decision: 'approve',
        content: checked.content,
      });
      if (!r.ok) {
        setFormError(r.message);
        toast.error(r.message);
        return;
      }
      toast.success('Sent');
      await after();
    });
  }

  function decline() {
    startTransition(async () => {
      const r = await resolveApprovalAction({
        approvalRequestId: e.approvalRequestId,
        decision: 'reject',
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success('Declined');
      await after();
    });
  }

  return (
    <div
      className="rounded-xl border border-run bg-canvas px-4 py-3.5"
      data-testid="elicitation-card"
    >
      <div className="flex items-start gap-3">
        <PlugsConnected size={16} className="mt-0.5 shrink-0 text-run" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-body-12 text-ink-3" data-testid="elicitation-header">
            MCP server “{e.server}” asks:
          </p>
          {/* Texte tiers : du texte brut, retours à la ligne gardés. */}
          <blockquote
            className="mt-1 whitespace-pre-wrap break-words border-l-2 border-rule pl-3 text-medium-14 text-ink"
            data-testid="elicitation-message"
          >
            {e.message}
          </blockquote>
        </div>
        <StatusTag status={e.status} />
      </div>

      {e.attachments.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2" data-testid="elicitation-attachments">
          {e.attachments.map((a) => {
            const href = attachmentHref(e.approvalRequestId, a.position);
            return (
              <li key={a.position} className="flex max-w-[160px] flex-col gap-1">
                <a href={href} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element -- image servie par une route authentifiée, taille inconnue à l'avance */}
                  <img
                    src={href}
                    alt={a.caption ?? `Image ${a.position + 1} from ${e.server}`}
                    className="h-24 w-auto max-w-[160px] rounded-md border border-rule-2 object-contain bg-paper"
                    data-testid="elicitation-thumbnail"
                  />
                </a>
                {a.caption && <span className="truncate text-body-12 text-ink-3">{a.caption}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {!parsed.ok ? (
        // Un formulaire hors du sous-ensemble du protocole : dit, jamais
        // dessiné à moitié. Le runner aura répondu au serveur de son côté.
        <p className="mt-3 text-body-12 text-warn" data-testid="elicitation-unreadable">
          This form cannot be shown: {parsed.reason}
        </p>
      ) : waiting ? (
        <>
          <div className="mt-3.5 flex flex-col gap-3">
            {fields.map((f) => (
              <FieldInput
                key={f.key}
                field={f}
                value={state[f.key]}
                error={errors[f.key]}
                disabled={isPending}
                onChange={(v) => set(f.key, v)}
              />
            ))}
          </div>
          {formError && (
            <p className="mt-2 text-body-12 text-err" role="alert">
              {formError}
            </p>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <PrimaryButton
              variant="neutral"
              size="sm"
              onClick={decline}
              disabled={isPending}
              data-testid="elicitation-decline"
            >
              {labels.decline}
            </PrimaryButton>
            <PrimaryButton
              variant="ink"
              size="sm"
              onClick={send}
              disabled={isPending}
              data-testid="elicitation-send"
            >
              {labels.accept}
            </PrimaryButton>
          </div>
        </>
      ) : (
        <Settled elicitation={e} fields={fields} />
      )}
    </div>
  );
}

function StatusTag({ status }: { status: string }) {
  if (status === 'pending') {
    return (
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-run" />
        <span className="text-mono-11-caps text-run">Waiting</span>
      </span>
    );
  }
  if (status === 'approved')
    return <span className="shrink-0 text-mono-11-caps text-ok">Sent</span>;
  if (status === 'rejected') {
    return <span className="shrink-0 text-mono-11-caps text-ink-3">Declined</span>;
  }
  return <span className="shrink-0 text-mono-11-caps text-ink-4">Expired</span>;
}

/** Ce qui a été répondu, ou pourquoi rien ne l'a été. */
function Settled({
  elicitation: e,
  fields,
}: {
  elicitation: ElicitationView;
  fields: ElicitationField[];
}) {
  if (e.status === 'approved') {
    const entries = Object.entries(e.response ?? {});
    return entries.length === 0 ? (
      <p className="mt-3 text-body-12 text-ink-3">Sent with no values.</p>
    ) : (
      <dl className="mt-3 flex flex-col gap-1" data-testid="elicitation-answer">
        {entries.map(([key, value]) => {
          const field = fields.find((f) => f.key === key);
          return (
            <div key={key} className="flex gap-2 text-body-12">
              <dt className="shrink-0 text-ink-3">{field?.label ?? key}</dt>
              <dd className="min-w-0 break-words text-ink">{describeAnswerValue(field, value)}</dd>
            </div>
          );
        })}
      </dl>
    );
  }
  if (e.status === 'rejected') {
    return <p className="mt-3 text-body-12 text-ink-3">Declined. The server was told no.</p>;
  }
  return (
    <p className="mt-3 text-body-12 text-ink-3" data-testid="elicitation-expired">
      {expiredReason(e.resolvedBy)}
    </p>
  );
}

function FieldInput({
  field: f,
  value,
  error,
  disabled,
  onChange,
}: {
  field: ElicitationField;
  value: ElicitationFormValue | undefined;
  error: string | undefined;
  disabled: boolean;
  onChange: (v: ElicitationFormValue) => void;
}) {
  const label = (
    <>
      {f.label}
      {f.required ? <span className="text-err"> *</span> : null}
    </>
  );
  const help = f.description ? (
    <p className="mt-1 text-body-12 text-ink-4">{f.description}</p>
  ) : null;
  const errorLine = error ? (
    <p className="mt-1 text-xs text-err" data-testid={`elicitation-error-${f.key}`}>
      {error}
    </p>
  ) : null;

  switch (f.kind) {
    case 'boolean':
      return (
        <div data-testid={`elicitation-field-${f.key}`}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-body-13 text-ink" id={`elicitation-${f.key}-label`}>
              {label}
            </span>
            <Switch
              checked={value === true}
              onChange={() => onChange(value !== true)}
              disabled={disabled}
              size="sm"
              ariaLabelledBy={`elicitation-${f.key}-label`}
            />
          </div>
          {help}
          {errorLine}
        </div>
      );
    case 'number':
      return (
        <div data-testid={`elicitation-field-${f.key}`}>
          <TextInput
            label={label}
            type="number"
            inputMode={f.integer ? 'numeric' : 'decimal'}
            step={f.integer ? 1 : 'any'}
            {...(f.minimum !== null ? { min: f.minimum } : {})}
            {...(f.maximum !== null ? { max: f.maximum } : {})}
            value={typeof value === 'string' ? value : ''}
            onChange={(ev) => onChange(ev.target.value)}
            disabled={disabled}
            error={error}
          />
          {help}
        </div>
      );
    case 'text':
      return (
        <div data-testid={`elicitation-field-${f.key}`}>
          <TextInput
            label={label}
            type={f.format === 'email' ? 'email' : f.format === 'uri' ? 'url' : 'text'}
            {...(f.maxLength !== null ? { maxLength: f.maxLength } : {})}
            value={typeof value === 'string' ? value : ''}
            onChange={(ev) => onChange(ev.target.value)}
            disabled={disabled}
            error={error}
          />
          {help}
        </div>
      );
    case 'choice':
      return (
        <div data-testid={`elicitation-field-${f.key}`}>
          <Select
            label={f.required ? `${f.label} *` : f.label}
            value={typeof value === 'string' ? value : ''}
            onChange={(ev) => onChange(ev.target.value)}
            disabled={disabled}
            error={error}
          >
            <option value="">Choose…</option>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          {help}
        </div>
      );
    case 'multi': {
      const selected = Array.isArray(value) ? value : [];
      return (
        <fieldset data-testid={`elicitation-field-${f.key}`}>
          <FieldLabel>{label}</FieldLabel>
          <div className="flex flex-col gap-1.5">
            {f.options.map((o) => (
              <Checkbox
                key={o.value}
                label={o.label}
                checked={selected.includes(o.value)}
                disabled={disabled}
                onChange={() =>
                  onChange(
                    selected.includes(o.value)
                      ? selected.filter((v) => v !== o.value)
                      : [...selected, o.value],
                  )
                }
              />
            ))}
          </div>
          {help}
          {errorLine}
        </fieldset>
      );
    }
  }
}
