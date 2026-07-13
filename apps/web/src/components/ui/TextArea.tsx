import { forwardRef, useId } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import FieldLabel from './FieldLabel';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> & {
  label?: string;
  error?: string;
  /**
   * Shows a right-aligned `{length} / {maxLength}` counter under the field
   * (NewMemoryModal's `Fact` pattern). Requires `maxLength` and a controlled
   * string `value` — silently omitted otherwise.
   */
  showCount?: boolean;
  className?: string;
  containerClassName?: string;
  /** Drops the canonical border/bg/padding chrome — for a textarea embedded in
   *  its own custom-chromed container (e.g. ChatClient's message composer,
   *  which sits inside a rounded floating card and needs to blend into it
   *  seamlessly). The caller's `className` then owns all visual styling. */
  bare?: boolean;
};

/**
 * TextArea — same field language as `TextInput` (rounded-md border-rule
 * bg-hover px-2 py-1.5 text-sm, focus:border-ink-3), resizable vertically.
 * See TextInput's docstring for why this geometry was chosen as canonical.
 */
const TextArea = forwardRef<HTMLTextAreaElement, Props>(function TextArea(
  {
    label,
    error,
    showCount,
    id,
    className = '',
    containerClassName = '',
    maxLength,
    value,
    bare = false,
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const taId = id ?? autoId;
  return (
    <div className={containerClassName}>
      {label && <FieldLabel htmlFor={taId}>{label}</FieldLabel>}
      <textarea
        id={taId}
        ref={ref}
        maxLength={maxLength}
        value={value}
        aria-invalid={error ? true : undefined}
        className={
          bare
            ? `w-full text-ink placeholder:text-ink-4 transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${className}`
            : `w-full resize-y rounded-md border bg-hover px-2 py-1.5 text-sm leading-[1.5] text-ink placeholder:text-ink-4 transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
                error ? 'border-err focus:border-err' : 'border-rule focus:border-ink-3'
              } ${className}`
        }
        {...rest}
      />
      {showCount && maxLength !== undefined && typeof value === 'string' && (
        <div className="mt-1 text-right text-[11px] text-ink-4">
          {value.length} / {maxLength}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-err">{error}</p>}
    </div>
  );
});

export default TextArea;
