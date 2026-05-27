import type { ReactNode } from 'react';
import type { AgentRow } from '@/lib/actions.ts';

/** Inline orchestrator icon — tree/branch shape from screen-gallery.jsx */
function OrcIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="6" cy="12" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M8 12h4M12 12V8a2 2 0 012-2h2M12 12v4a2 2 0 002 2h2" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <circle cx="4" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12" cy="8" r="1.2" />
    </svg>
  );
}

type Props = {
  orchestrator: AgentRow;
  workerCount: number;
  /** Worker slot list — rendered as the indented .orc-workers bucket. */
  children: ReactNode;
  /** Optional drag-related props for the card container (dnd-kit useSortable). */
  style?: React.CSSProperties;
  className?: string;
  /** Ref forwarded from useSortable. */
  cardRef?: React.Ref<HTMLDivElement>;
  /** Drag-handle props for the header — applied to a grip element. */
  dragHandleProps?: object;
  /** Called when "+ Add worker" is clicked. */
  onAddWorker?: () => void;
};

/**
 * OrchestratorCard — the collapsible team card used in the Hierarchy view of
 * /agents. Maps to `.orc` in the design bundle (styles.css lines 1810-1845).
 *
 * Header: ink square mark with OrcIcon + "ORCHESTRATOR · N workers" label +
 * orchestrator name + tagline (role) + more button. Body: an indented
 * `.orc-workers` region (passed as `children`). Footer: "+ Add worker" dashed
 * button which callers can wire to open the AgentForm.
 *
 * The drag-handle spans the ink mark — callers forward dnd-kit listeners to
 * `dragHandleProps` so only that 42px square initiates a drag.
 */
export default function OrchestratorCard({
  orchestrator,
  workerCount,
  children,
  style,
  className = '',
  cardRef,
  dragHandleProps,
  onAddWorker,
}: Props) {
  return (
    <div
      ref={cardRef}
      style={style}
      className={`rounded-[14px] border border-rule-2 bg-paper px-5 pb-3.5 pt-[18px] ${className}`}
    >
      {/* Header */}
      <div className="mb-3.5 flex items-start gap-3.5">
        {/* Ink mark — drag handle in hierarchy view */}
        <div
          {...dragHandleProps}
          className="flex h-[42px] w-[42px] shrink-0 cursor-grab touch-none items-center justify-center rounded-[10px] bg-ink text-canvas active:cursor-grabbing"
          aria-label="Drag orchestrator"
          title="Drag to reorder team"
        >
          <span className="h-[22px] w-[22px]">
            <OrcIcon />
          </span>
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-4">
              Orchestrator
            </span>
            <span className="inline-flex h-[18px] items-center rounded-[5px] bg-agent-vivid px-2 font-mono text-[10px] font-medium leading-none tracking-[0.04em] text-[#0a0a0a]">
              {workerCount} {workerCount === 1 ? 'worker' : 'workers'}
            </span>
          </div>
          <div className="mt-1.5 text-[17px] font-semibold leading-[1.2] tracking-[-0.01em] text-ink">
            {orchestrator.name}
          </div>
          <div className="mt-0.5 text-[12.5px] leading-[1.4] text-ink-3">{orchestrator.slug}</div>
        </div>

        {/* More button */}
        <button
          type="button"
          aria-label="More options"
          className="flex h-7 w-7 items-center justify-center rounded-[7px] border-0 bg-transparent text-ink-4 hover:bg-hover hover:text-ink-2"
        >
          <DotsIcon />
        </button>
      </div>

      {/* Workers region */}
      <div className="ml-6 flex flex-col gap-1.5 border-l border-dashed border-rule pl-3.5">
        {children}
      </div>

      {/* Add worker */}
      <button
        type="button"
        onClick={onAddWorker}
        className="ml-6 mt-2 flex h-[38px] w-[calc(100%-24px)] items-center justify-center gap-1.5 rounded-[9px] border border-dashed border-rule bg-transparent text-[12.5px] font-medium text-ink-3 hover:bg-hover hover:text-ink-2"
      >
        <span className="h-[13px] w-[13px]">
          <PlusIcon />
        </span>
        Add worker
      </button>
    </div>
  );
}
