'use client';

/**
 * SetCtaRow — right-aligned Cancel + Save buttons for settings form sections.
 * `onCancel` is required (handler). `pending` disables Save and shows "Saving…".
 */
export function SetCtaRow({
  onCancel,
  pending,
  saveLabel = 'Save',
}: {
  onCancel: () => void;
  pending?: boolean;
  saveLabel?: string;
}) {
  return (
    <div className="flex justify-end gap-2 mt-[18px]">
      <button
        type="button"
        onClick={onCancel}
        className="h-[34px] px-3.5 rounded-[9px] cursor-pointer bg-paper border border-rule text-[14px] font-medium text-ink-2 hover:bg-hover hover:border-rule-2 transition-colors"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={pending}
        className="h-[34px] px-4 rounded-[9px] border-0 cursor-pointer bg-ink text-canvas text-[14px] font-medium hover:brightness-90 disabled:opacity-50 transition-[filter,opacity]"
      >
        {pending ? 'Saving…' : saveLabel}
      </button>
    </div>
  );
}
