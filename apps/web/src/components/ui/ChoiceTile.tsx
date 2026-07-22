import type { ReactNode } from 'react';

type Props = {
  icon: ReactNode;
  label: ReactNode;
  onClick: () => void;
  className?: string;
};

/**
 * ChoiceTile — icon + label tile for a grid of mutually-exclusive choices
 * that each trigger a navigation/action (as opposed to `OptionRadio`, which
 * tracks a persisted selection). First call site: OnboardingFlow's
 * messaging-channel picker grid. Geometry: `rounded-lg border px-4 py-3`,
 * icon left, label right.
 */
export default function ChoiceTile({ icon, label, onClick, className = '' }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-3 rounded-lg border border-rule-2 bg-canvas px-4 py-3 text-left transition-colors hover:border-ink ${className}`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="text-medium-13 text-ink">{label}</span>
    </button>
  );
}
