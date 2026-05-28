'use client';

/**
 * EmojiPicker — a compact preset grid for choosing a workspace icon. Shared by
 * the create + edit workspace forms (one component, reused) so the icon choice
 * is consistent everywhere. Kept to a curated preset set (no heavyweight emoji
 * dependency); the value is just the chosen emoji string.
 */

export const WORKSPACE_EMOJI_PRESETS = [
  '🗂️',
  '🏠',
  '💼',
  '🚀',
  '🧪',
  '🎨',
  '📊',
  '🛠️',
  '🌐',
  '⚡',
  '🤖',
  '📦',
];

type Props = {
  value: string;
  onChange: (emoji: string) => void;
  disabled?: boolean;
};

export default function EmojiPicker({ value, onChange, disabled }: Props) {
  return (
    <div className="flex flex-wrap gap-1">
      {WORKSPACE_EMOJI_PRESETS.map((emoji) => {
        const active = value === emoji;
        return (
          <button
            key={emoji}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(emoji)}
            className={`flex h-8 w-8 items-center justify-center rounded-md border text-[15px] leading-none transition-colors disabled:opacity-50 ${
              active ? 'border-ink bg-hover-2' : 'border-rule-2 hover:bg-hover'
            }`}
          >
            {emoji}
          </button>
        );
      })}
    </div>
  );
}
