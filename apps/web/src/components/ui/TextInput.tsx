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
 * app (the convention shared by ConnectorAddForm, McpAddForm, McpEditForm,
 * CredentialWizard, SkillForm, WebhookForm and 5+ more forms). Geometry
 * (figma-sync 2026-07-16, Quentin's DS pass): `pl-3 pr-2 py-1.5` +
 * `text-[14px] leading-5` — EXPLICIT 14px, deliberately off the `text-sm`
 * scale token (15px) so fields sit one step below labels/titles; the wider
 * left padding gives the caret breathing room. Box math: 20px line-height +
 * 12px padding + 2px border = 34px, flush with `PrimaryButton`/`IconButton`
 * `md` so a field and a button sit level in the same row. Mirrored in Figma
 * by the TextInput set (text style Body/14, padL 12).
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
        className={`w-full rounded-md border bg-hover py-1.5 pr-2 pl-3 text-body-14 leading-5! text-ink placeholder:text-ink-4 transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
          error ? 'border-err focus:border-err' : 'border-rule focus:border-ink-3'
        } ${className}`}
        {...rest}
      />
      {error && <p className="mt-1 text-xs text-err">{error}</p>}
    </div>
  );
});

export default TextInput;
