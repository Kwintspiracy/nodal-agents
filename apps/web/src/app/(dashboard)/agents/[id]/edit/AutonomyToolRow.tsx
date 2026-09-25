'use client';

// AutonomyToolRow: one tool on the Approvals tab, as the OWNER reads it.
//
// Two texts, two readers (issue #382): `label` is the short imperative title,
// `summary` the sentence or two underneath. The tool's `description` is written
// for the MODEL and never reaches this component. It used to be what the row
// showed, and the owner got a wall of "do NOT" addressed to someone else.
//
// Its own file, and not a helper inside AgentComposer: a row is the smallest
// thing this screen promises, so it is the thing a component test renders.

import SegmentedControl from '@/components/ui/SegmentedControl';

export type AutonomyAction = 'auto_approve' | 'require_approval' | 'block';

/**
 * What the agent can reach, in the vocabulary the connector operations already
 * use, so one row reads the same wherever it appears.
 */
const ACCESS_LABEL: Readonly<Record<string, string>> = {
  read: 'Read',
  write: 'Write',
  destructive: 'Cannot be undone',
};

export default function AutonomyToolRow({
  slug,
  label,
  summary,
  risk,
  value,
  saving,
  onChange,
  lockedReason,
  folder,
}: {
  /** The tool name. Stays visible: it is what the owner sees in a transcript. */
  slug: string;
  label: string;
  summary: string;
  risk: 'read' | 'write' | 'destructive';
  /** `null` : pas de règle, rien n'est choisi (`run_command`, #468). */
  value: AutonomyAction | null;
  saving: boolean;
  onChange: (action: AutonomyAction) => void;
  /**
   * Set for a tool that may not be blocked (return_result). The row still
   * renders, because an owner who counts the built-in tools in the docs and
   * finds one fewer here would rightly wonder what is being hidden, but the control is
   * replaced by the reason. The server refuses the rule too; this is the
   * affordance, not the guard.
   */
  lockedReason?: string;
  /**
   * The folder this rule is confined to, when it carries one (issue #361).
   *
   * Since « Approve for this project » (#360) a rule can read « approved, but
   * only while the agent works there ». Without this the row said « Run
   * without asking » where the truth was « Run without asking in Dev », and
   * the owner had no way to see the difference.
   */
  folder?: string;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      {/* Tool identity */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-medium-14 text-ink">{label}</span>
          <span
            className={[
              'inline-flex h-[18px] items-center rounded-full px-2 text-mono-11 uppercase tracking-[0.1em]',
              risk === 'destructive'
                ? 'bg-err/10 text-err'
                : risk === 'write'
                  ? 'bg-warn/10 text-warn'
                  : 'bg-hover text-ink-3',
            ].join(' ')}
          >
            {ACCESS_LABEL[risk] ?? risk}
          </span>
        </div>
        <p className="mt-0.5 text-body-13 leading-[1.4]! text-ink-3">{summary}</p>
        <code className="mt-1 block text-mono-11 text-ink-4">{slug}</code>
      </div>

      {lockedReason !== undefined ? (
        <div className="flex max-w-xs flex-col items-start gap-1 sm:items-end">
          {/*
            Le dossier s'affiche AUSSI sur une ligne verrouillée (revue Reviewer
            C, passe 3, C4) : le verrou n'interdit que le blocage, une règle de
            dossier existe ici comme ailleurs, et la taire ferait lire
            « partout ».
          */}
          {folder !== undefined && (
            <span className="text-body-12 text-ink-4" data-testid={`autonomy-folder-${slug}`}>
              in {folder}
            </span>
          )}
          <p
            className="text-body-12 leading-[1.4]! text-ink-4 sm:text-right"
            data-testid={`autonomy-locked-${slug}`}
          >
            {lockedReason}
          </p>
        </div>
      ) : (
        /* 3-way control, with the folder the rule is confined to beside it */
        <div className="flex flex-col items-start gap-1 sm:items-end">
          {folder !== undefined && (
            <span className="text-body-12 text-ink-4" data-testid={`autonomy-folder-${slug}`}>
              in {folder}
            </span>
          )}
          <SegmentedControl
            value={value}
            onChange={onChange}
            disabled={saving}
            // Le dossier fait partie du NOM de ce réglage : sans lui, un lecteur
            // d'écran annonce « Run without asking » sans la moitié qui compte
            // (revue Reviewer C, passe 1, C4).
            ariaLabel={
              folder === undefined
                ? `Approval rule for ${label}`
                : `Approval rule for ${label}, limited to ${folder}`
            }
            options={[
              {
                value: 'auto_approve' as const,
                label: 'Run without asking',
                activeClassName: 'bg-agent-vivid/15 text-agent-vivid border-agent-vivid/30',
                testId: `autonomy-btn-${slug}-auto_approve`,
              },
              {
                value: 'require_approval' as const,
                label: 'Ask for approval',
                activeClassName: 'bg-warn/15 text-warn border-warn/30',
                testId: `autonomy-btn-${slug}-require_approval`,
              },
              {
                value: 'block' as const,
                label: 'Block',
                activeClassName: 'bg-err/15 text-err border-err/30',
                testId: `autonomy-btn-${slug}-block`,
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
