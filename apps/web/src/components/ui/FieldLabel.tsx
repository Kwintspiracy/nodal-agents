import type { LabelHTMLAttributes, ReactNode } from 'react';

type Props = LabelHTMLAttributes<HTMLLabelElement> & {
  children: ReactNode;
};

/**
 * FieldLabel — the canonical form-field label: `text-xs text-ink-3`, `mb-1`
 * below. Chosen as the dominant convention over an audit of every form in the
 * app (AgentForm, ConnectorForm/ConnectorAddForm, McpAddForm/McpEditForm/
 * McpServerForm, CredentialWizard, SkillForm, WebhookForm, ScheduleForm,
 * LogFilters — 16 files) — the loud `font-mono uppercase` variant in
 * AgentComposer/LlmKeyForm is that page's own bespoke idiom, not the app norm
 * (UX-DS Phase 1 audit).
 *
 * `TextInput`/`TextArea`/`Select` render this internally via their `label`
 * prop — reach for it directly only when a label needs to sit over a
 * non-native control (e.g. NewMemoryModal's star-rating `Importance` label).
 */
export default function FieldLabel({ children, className = '', ...rest }: Props) {
  return (
    <label className={`block text-xs text-ink-3 mb-1 ${className}`} {...rest}>
      {children}
    </label>
  );
}
