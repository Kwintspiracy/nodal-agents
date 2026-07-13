import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import FieldLabel from './FieldLabel';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> & {
  /** Optional built-in label — renders a `FieldLabel` wired to the input via `htmlFor`/`id`.
   *  Usually a string; a fragment is fine too (e.g. a trailing "(optional)" hint). */
  label?: ReactNode;
  /** Validation message shown below the field in `text-err`; also flips the border to `border-err`. */
  error?: string;
  /** Classes on the field itself (input). Use `containerClassName` for the wrapping `<div>`. */
  className?: string;
  containerClassName?: string;
};

/**
 * TextInput — canonical text/password/url/number field for every form in the
 * app. Geometry (audit UX-DS Phase 1): `rounded-md border-rule bg-hover
 * px-2 py-1.5 text-sm`, `focus:border-ink-3` — the convention already shared
 * by ConnectorAddForm, McpAddForm, McpEditForm's own `INPUT` const,
 * CredentialWizard, SkillForm, WebhookForm and 5 more forms (10+ files, the
 * single largest cluster found). Its content-box height (20px line-height +
 * 12px padding + 2px border = 34px) is intentional: it matches
 * `PrimaryButton`/`IconButton`'s `md` size, so a field and a button sit flush
 * in the same row.
 *
 * Forwards its ref (autofocus-on-open patterns, e.g. rename rows).
 */
const TextInput = forwardRef<HTMLInputElement, Props>(function TextInput(
  { label, error, id, className = '', containerClassName = '', ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={containerClassName}>
      {label && <FieldLabel htmlFor={inputId}>{label}</FieldLabel>}
      <input
        id={inputId}
        ref={ref}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded-md border bg-hover px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
          error ? 'border-err focus:border-err' : 'border-rule focus:border-ink-3'
        } ${className}`}
        {...rest}
      />
      {error && <p className="mt-1 text-xs text-err">{error}</p>}
    </div>
  );
});

export default TextInput;
