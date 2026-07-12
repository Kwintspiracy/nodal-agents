'use client';

import {
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { DotsThree } from '@phosphor-icons/react';
import IconButton from './IconButton';

export type MenuItem = {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
};

type Props = {
  items: MenuItem[];
  /** Custom trigger element — Menu clones it (via `cloneElement`, React's own
   *  ref-forwarding idiom — a plain function call would trip the
   *  react-hooks/refs rule, since ESLint can't prove an arbitrary callback
   *  won't read `ref.current` synchronously during render) adding onClick,
   *  aria-haspopup, aria-expanded and a ref. Must be a single focusable host
   *  element (e.g. a `<button>`) that doesn't set its own `ref`. Omit to get
   *  the default kebab (Phosphor `DotsThree`) IconButton. */
  trigger?: ReactElement;
  /** aria-label / title for the default trigger. Ignored when `trigger` is passed. */
  triggerLabel?: string;
  /** Which edge of the trigger the panel hugs. Default 'right' — matches
   *  every existing row-kebab menu, which all sit at a table's right edge. */
  align?: 'left' | 'right';
  /** Extra classes on the panel (e.g. a wider min-width for long labels). */
  className?: string;
};

const MIN_PANEL_WIDTH = 160;

/**
 * Menu — the shared contextual dropdown (audit UX-B1). Before this, three
 * bespoke popups existed with no shared component and, critically, zero
 * `createPortal` calls anywhere in apps/web: SkillsAssignedTable's row kebab
 * rendered its panel as an `absolute` CHILD of the table's
 * `overflow-hidden` card, so the last row's menu got clipped by the table's
 * own border — reproduced live on /skills. Escaping that requires the panel
 * to be a sibling of the clipping container, which only a portal gives you.
 *
 * The panel renders through `createPortal(document.body)` in `position:
 * fixed`, positioned from the trigger's `getBoundingClientRect()`, with a
 * vertical flip above the trigger when there isn't room below. Visual
 * language (rounded-[9px], border-rule-2, bg-paper, that exact shadow) is
 * lifted verbatim from SkillsAssignedTable.tsx:161 and FleetPicker's
 * workspace dropdown — the two clearest existing examples.
 *
 * Scroll/resize choice: the menu CLOSES rather than repositions. Keeping it
 * open and recalculating the flip/clamp math on every scroll frame (across
 * however many nested scroll containers a row happens to be in) is real,
 * ongoing complexity for very little benefit — closing on scroll matches how
 * native `<select>` and most dropdown libraries behave, and costs the user
 * one extra click to reopen it.
 */
export default function Menu({
  items,
  trigger,
  triggerLabel = 'More actions',
  align = 'right',
  className = '',
}: Props) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    // Portal gate — createPortal needs `document`, only present post-hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  const close = () => {
    setOpen(false);
    // Reset so the next open re-measures through the hidden-first-paint pass
    // below — coords from a previous open would skip it and reuse a stale
    // position.
    setCoords(null);
  };
  const toggle = () => setOpen((v) => !v);

  // Position the panel BEFORE paint (useLayoutEffect) so it never flashes at
  // the wrong spot — by the time this runs the panel is already in the DOM
  // with its real height/width.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger) return;
    const tRect = trigger.getBoundingClientRect();
    const panelHeight = panel?.offsetHeight ?? 0;
    const panelWidth = panel?.offsetWidth ?? MIN_PANEL_WIDTH;
    const spaceBelow = window.innerHeight - tRect.bottom;
    const spaceAbove = tRect.top;
    const flip = spaceBelow < panelHeight + 8 && spaceAbove > spaceBelow;
    const top = flip ? tRect.top - panelHeight - 4 : tRect.bottom + 4;
    const left = align === 'left' ? tRect.left : Math.max(8, tRect.right - panelWidth);
    setCoords({ top, left });

    const firstEnabled = items.findIndex((it) => !it.disabled);
    if (firstEnabled >= 0) itemRefs.current[firstEnabled]?.focus();
  }, [open, align, items]);

  // Outside click, Escape, scroll (any ancestor, via capture), resize.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        close();
        triggerRef.current?.focus();
      }
    }
    function onScrollOrResize() {
      close();
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open]);

  function handlePanelKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const enabledIdx = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
    if (enabledIdx.length === 0) return;
    const currentIdx = itemRefs.current.findIndex((el) => el === document.activeElement);
    const pos = enabledIdx.indexOf(currentIdx);
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const nextPos = pos < 0 ? 0 : (pos + delta + enabledIdx.length) % enabledIdx.length;
    itemRefs.current[enabledIdx[nextPos]]?.focus();
  }

  const triggerNode =
    trigger && isValidElement(trigger) ? (
      /* cloneElement forwards the ref via React's element-clone contract (the
       * same mechanism forwardRef uses internally); it hands the ref to
       * React's commit phase and does not itself read `.current` during
       * render. The rule can't statically tell cloneElement apart from an
       * arbitrary callback that might, hence the disable below. */
      // eslint-disable-next-line react-hooks/refs
      cloneElement(trigger as ReactElement<Record<string, unknown>>, {
        onClick: toggle,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        ref: triggerRef,
      })
    ) : (
      <IconButton
        size="sm"
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        ref={triggerRef}
      >
        <DotsThree size={16} weight="bold" />
      </IconButton>
    );

  return (
    <>
      {triggerNode}
      {open &&
        mounted &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            aria-label={triggerLabel}
            onKeyDown={handlePanelKeyDown}
            // First paint is HIDDEN at 0,0: the panel must exist in the DOM for
            // the layout effect to measure its real height — otherwise the flip
            // decision runs with panelHeight=0 and a tall menu near the bottom
            // of the VIEWPORT (exactly the audit's repro spot) renders below and
            // gets cut by the screen edge on its first open.
            style={
              coords
                ? { position: 'fixed', top: coords.top, left: coords.left }
                : { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }
            }
            className={`z-50 min-w-[160px] rounded-[9px] border border-rule-2 bg-paper p-1 shadow-[0_12px_32px_rgba(0,0,0,0.10)] ${className}`}
          >
            {items.map((item, i) => (
              <button
                key={item.label + i}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors disabled:opacity-40 ${
                  item.tone === 'danger'
                    ? 'text-err hover:bg-warn-bg'
                    : 'text-ink-2 hover:bg-hover hover:text-ink'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
