import { Children, cloneElement, forwardRef, isValidElement, useId } from 'react';
import type { OptgroupHTMLAttributes, ReactElement, ReactNode, SelectHTMLAttributes } from 'react';
import { CaretDown } from '@phosphor-icons/react/dist/ssr';
import FieldLabel from './FieldLabel';

/**
 * Injects a `<legend>` (the customizable-select section header, styled in
 * `globals.css`) into every `<optgroup>`, derived from its `label` attribute.
 * The attribute stays for browsers without `base-select` (the OS picker reads
 * it and ignores the legend); where `base-select` applies, the legend replaces
 * the UA-rendered label, whose geometry CSS cannot control.
 */
function withSectionLegends(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement(child) || child.type !== 'optgroup') return child;
    const group = child as ReactElement<OptgroupHTMLAttributes<HTMLOptGroupElement>>;
    if (!group.props.label) return group;
    return cloneElement(group, {}, <legend>{group.props.label}</legend>, group.props.children);
  });
}

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> & {
  label?: string;
  error?: string;
  className?: string;
  containerClassName?: string;
};

/**
 * Select — wraps the native `<select>` (kept native for a11y/mobile picker
 * support — no custom listbox) in the same field chrome as `TextInput`. The
 * native browser arrow is replaced by the DS caret (Phosphor `CaretDown`
 * 16px ink-3, per the Figma Select component). The dropdown menu itself is
 * styled to the DS "Open" state via `appearance: base-select` in
 * `globals.css` (customizable select, Chrome/Edge 135+; other browsers keep
 * the OS picker) — the `appearance` cascade lives there, so don't add
 * `appearance-none` here or it would override `base-select`. Same
 * `md`/34px height so it lines up with a button or input beside it. The
 * height is explicit (`h-8.5`) because Chrome's UA stylesheet forces
 * `line-height: normal !important` on selects, so unlike `TextInput` the
 * `leading-5!` can't produce the 34px box on its own. Options
 * are passed as `children` (`<option>`/`<optgroup>`), same as raw `<select>`.
 * On a `required` select, an `<option value="">` acts as the placeholder:
 * while it is selected the field is `:invalid` and the text renders ink-4,
 * like `placeholder:` on `TextInput`. A non-required select keeps ink for
 * `value=""` options ("All agents", "Auto", …) since those are real values.
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
      <div className="relative">
        <select
          id={selectId}
          ref={ref}
          aria-invalid={error ? true : undefined}
          className={`peer h-8.5 w-full rounded-md border bg-hover py-1.5 pr-8 pl-3 text-body-14 leading-5! text-ink transition-colors required:invalid:text-ink-4 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
            error ? 'border-err focus:border-err' : 'border-rule focus:border-ink-3'
          } ${className}`}
          {...rest}
        >
          {withSectionLegends(children)}
        </select>
        {/* top-4.25 = 17px, le centre du champ h-8.5 — PAS top-1/2 : un
            margin passé via className (ex. mb-2) grandit le wrapper et
            décentrerait le caret. */}
        <CaretDown
          size={16}
          aria-hidden
          className="pointer-events-none absolute top-4.25 right-2 -translate-y-1/2 text-ink-3 peer-disabled:opacity-50"
        />
      </div>
      {error && <p className="mt-1 text-xs text-err">{error}</p>}
    </div>
  );
});

export default Select;
