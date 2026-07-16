import type { ModelToolsSupport } from '@nodal-agents/shared';

const STYLE: Record<ModelToolsSupport, string> = {
  yes: 'bg-ok-bg text-ok',
  no: 'bg-warn-bg text-warn',
  unknown: 'bg-hover text-ink-4',
};

const LABEL: Record<ModelToolsSupport, string> = {
  yes: 'Tools',
  no: 'No tools',
  unknown: 'Tools ?',
};

const TITLE: Record<ModelToolsSupport, string> = {
  yes: 'This model can call tools.',
  no: "This model can't call tools and can't power an agent.",
  unknown: 'Tool support is unknown for this model (not in the curated catalog).',
};

/**
 * ModelToolsBadge — compact pill for a model's tool-calling capability. Used
 * where a model is rendered as real JSX (e.g. HeroCard's model chip). Native
 * `<option>` elements in the various model `<select>`s can't host this (plain
 * text only) — those instead use `modelOptionLabel` from
 * `@nodal-agents/shared` to fold the same information into the option text.
 *
 * Geometry (h-[22px] rounded-[5px] px-2.5 text-[12px]) matches the rest of
 * the pill family — StatusPill, StageBadge (audit UX-B1: this badge had
 * drifted to h-[20px]/px-2/text-[11px]).
 */
export default function ModelToolsBadge({
  support,
  className = '',
}: {
  support: ModelToolsSupport;
  className?: string;
}) {
  return (
    <span
      title={TITLE[support]}
      className={`inline-flex h-[22px] items-center rounded-[5px] px-2.5 text-medium-12 leading-none! ${STYLE[support]} ${className}`}
    >
      {LABEL[support]}
    </span>
  );
}

/**
 * ModelToolsLegend — one-line explainer placed near a model picker so the
 * badge/suffix meaning is never ambiguous. Shared verbatim across the create
 * agent modal, the agent edit Settings tab, and onboarding's model step.
 */
export function ModelToolsLegend({ className = '' }: { className?: string }) {
  return (
    <p className={`text-legacy-11-5 leading-[1.5]! text-ink-4 ${className}`}>
      Models marked <span className="font-medium text-warn">(no tools)</span> can&apos;t power an
      agent.
    </p>
  );
}
