'use client';

// McpServerTools : sous la ligne d'un serveur MCP, ses outils, un par ligne
// (issue #357).
//
// Pourquoi : la section ne portait qu'une ligne PAR SERVEUR, motif
// `<prefix>__*`. Poser une règle sur UN outil de ce serveur pour CET agent
// n'était possible nulle part depuis la page de l'agent ; le seul endroit qui
// savait l'écrire était la carte d'approbation, et #346 en a retiré les
// boutons. Cas rapporté le 21/09 : garder `mcp_playwright__*` autonome et
// bloquer `mcp_playwright__browser_run_code_unsafe`, impossible à dire.
//
// Le dépli, et pas une liste toujours ouverte : un serveur en expose souvent
// trente, et la décision ordinaire porte sur le serveur.

import { useState } from 'react';
import DisclosureButton from '@/components/ui/DisclosureButton';
import SegmentedControl from '@/components/ui/SegmentedControl';
import type { AutonomyAction } from './AutonomyToolRow.tsx';

/** `null` = aucune règle sur l'outil exact : il suit celle du serveur. */
export type McpToolRule = AutonomyAction | null;

export default function McpServerTools({
  prefix,
  serverLabel,
  tools,
  ruleFor,
  isSaving,
  onChange,
}: {
  /** Le préfixe du serveur, `cogni_cortex` pour `cogni_cortex__*`. */
  prefix: string;
  serverLabel: string;
  tools: readonly { name: string; description?: string }[];
  ruleFor: (toolName: string) => McpToolRule;
  isSaving: (toolName: string) => boolean;
  onChange: (toolName: string, action: McpToolRule) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = tools.length;

  return (
    <div className="border-t border-rule-2 bg-hover/30">
      <DisclosureButton
        open={open}
        onClick={() => setOpen(!open)}
        inset="default"
        testId={`autonomy-mcp-fold-${prefix}`}
      >
        <span className="text-body-13 text-ink-3">
          {count} {count === 1 ? 'tool' : 'tools'}
        </span>
      </DisclosureButton>

      {open && (
        <div
          className="divide-y divide-rule-2 border-t border-rule-2"
          data-testid={`autonomy-mcp-tools-${prefix}`}
        >
          {tools.map((tool) => {
            const name = `${prefix}__${tool.name}`;
            const value = ruleFor(name);
            return (
              <div
                key={name}
                className="flex flex-col gap-2 px-4 py-2.5 pl-10 sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="min-w-0 flex-1">
                  <code className="block text-mono-12 text-ink-2">{tool.name}</code>
                  {tool.description !== undefined && tool.description !== '' && (
                    <p className="mt-0.5 truncate text-body-12 text-ink-4">{tool.description}</p>
                  )}
                </div>
                <SegmentedControl
                  value={value ?? 'inherit'}
                  onChange={(next) => onChange(name, next === 'inherit' ? null : next)}
                  disabled={isSaving(name)}
                  ariaLabel={`Approval rule for ${tool.name} on ${serverLabel}`}
                  options={[
                    {
                      value: 'inherit' as const,
                      label: 'Follow the server',
                      activeClassName: 'bg-hover text-ink-2 border-rule',
                      testId: `autonomy-btn-${name}-inherit`,
                    },
                    {
                      value: 'auto_approve' as const,
                      label: 'Run without asking',
                      activeClassName: 'bg-agent-vivid/15 text-agent-vivid border-agent-vivid/30',
                      testId: `autonomy-btn-${name}-auto_approve`,
                    },
                    {
                      value: 'require_approval' as const,
                      label: 'Ask for approval',
                      activeClassName: 'bg-warn/15 text-warn border-warn/30',
                      testId: `autonomy-btn-${name}-require_approval`,
                    },
                    {
                      value: 'block' as const,
                      label: 'Block',
                      activeClassName: 'bg-err/15 text-err border-err/30',
                      testId: `autonomy-btn-${name}-block`,
                    },
                  ]}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
