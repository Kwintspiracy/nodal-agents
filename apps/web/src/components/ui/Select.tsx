import { forwardRef, useId } from 'react';
import type { SelectHTMLAttributes } from 'react';
import FieldLabel from './FieldLabel';

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> & {
  label?: string;
  error?: string;
  className?: string;
  containerClassName?: string;
};

/**
 * Select — wraps the native `<select>` (kept native for a11y/mobile picker
 * support — no custom listbox) in the same field chrome as `TextInput`, same
 * `md`/34px height so it lines up with a button or input beside it. Options
 * are passed as `children` (`<option>`/`<optgroup>`), same as raw `<select>`.
 */
const Select = forwardRef<HTMLSelectElement, Props>(function Select(
  { label, error, id, className = '', containerClassName = '', children, ...rest },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <div className={containerClassName}>
      {label && <FieldLabel htmlFor={selectId}>{label}</FieldLabel>}
      <select
        id={selectId}
        ref={ref}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded-md border bg-hover px-2 py-1.5 text-sm text-ink transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
          error ? 'border-err focus:border-err' : 'border-rule focus:border-ink-3'
        } ${className}`}
        {...rest}
      >
        {children}
      </select>
      {error && <p className="mt-1 text-xs text-err">{error}</p>}
    </div>
  );
});

export default Select;
