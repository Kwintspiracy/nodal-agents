'use client';

import { useState, type ReactNode } from 'react';
import { agentTeams, recipesOfTeam, type AgentRecipe } from '@nodal-agents/catalog';
import Modal, { ModalFooter } from './ui/Modal.tsx';
import PrimaryButton from './ui/PrimaryButton.tsx';
import RecipeTile from './ui/RecipeTile.tsx';
import AgentForm from './AgentForm.tsx';
import type { AgentRow, LlmKeyUiRow } from '@/lib/actions.ts';

/**
 * RecipePicker — "What should this agent do?"
 *
 * The first screen of agent creation. It shows the teams that ship with the
 * product as SUGGESTIONS: a name and a shape that teach what tends to work.
 * Nothing here creates anything, and there is no "build the team" button —
 * the first draft of this feature had one, and it handed people a structure
 * they had not chosen. Each recipe opens the ordinary create form (AgentForm),
 * pre-filled, one agent at a time; "Start from scratch" opens it empty.
 *
 * The word "recipe" never appears on screen on purpose: the user sees a
 * question and choices. The term lives in code and in the catalog only.
 */

interface Props {
  llmKeys: LlmKeyUiRow[];
  agents: AgentRow[];
  /** Custom trigger; defaults to the "+ New agent" button AgentForm renders. */
  renderTrigger?: (open: () => void) => ReactNode;
}

export default function RecipePicker({ llmKeys, agents, renderTrigger }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // `null` = picker not resolved yet; `undefined` = "from scratch" (no recipe).
  const [choice, setChoice] = useState<AgentRecipe | undefined | null>(null);

  // Names already in the workspace, so a recipe whose agent exists is marked as
  // such — to INFORM ("you have one"), never to ask for completion. Matched on
  // the display name, which is what the recipe pre-fills and what the user
  // sees; a renamed agent simply stops matching, which is fine.
  const existingNames = new Set(agents.map((a) => a.name.trim().toLowerCase()));

  function pick(recipe: AgentRecipe | undefined) {
    setPickerOpen(false);
    setChoice(recipe);
  }

  const trigger = renderTrigger ? (
    renderTrigger(() => setPickerOpen(true))
  ) : (
    <PrimaryButton variant="agent" onClick={() => setPickerOpen(true)}>
      New agent
    </PrimaryButton>
  );

  return (
    <>
      {trigger}

      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="What should this agent do?"
        className="max-w-2xl"
        footer={
          <ModalFooter>
            <PrimaryButton variant="neutral" type="button" onClick={() => setPickerOpen(false)}>
              Cancel
            </PrimaryButton>
          </ModalFooter>
        }
      >
        <p className="text-body-13 text-ink-3 mb-4">
          The teams below are suggestions. Nothing requires creating all of them, or in this order —
          each choice creates one agent.
        </p>

        <div className="space-y-5">
          {agentTeams.map((team) => (
            <section key={team.slug} aria-label={team.name}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-1">
                <h3 className="text-medium-13 uppercase tracking-wider text-ink-3">{team.name}</h3>
                <span className="font-mono text-[11px] text-ink-3">{team.shape}</span>
              </div>
              <p className="text-body-13 text-ink-3 mb-2.5 max-w-prose">{team.rationale}</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {recipesOfTeam(team).map((recipe) => {
                  const exists = existingNames.has(recipe.name.trim().toLowerCase());
                  return (
                    <RecipeTile
                      key={recipe.slug}
                      onClick={() => pick(recipe)}
                      title={recipe.name}
                      description={recipe.summary}
                      tags={recipe.kit}
                      muted={exists}
                      badge={
                        exists ? (
                          <span className="font-mono text-[9.5px] uppercase tracking-wider text-ink-3">
                            already here
                          </span>
                        ) : undefined
                      }
                    />
                  );
                })}
              </div>
            </section>
          ))}

          <section aria-label="Custom">
            <h3 className="text-medium-13 uppercase tracking-wider text-ink-3 mb-2.5">Custom</h3>
            <RecipeTile
              onClick={() => pick(undefined)}
              title="Start from scratch"
              description="The empty form, as before."
              className="sm:w-auto"
            />
          </section>
        </div>
      </Modal>

      {choice !== null && (
        <AgentForm
          key={choice?.slug ?? 'scratch'}
          llmKeys={llmKeys}
          agents={agents}
          recipe={choice}
          openInitially
          onClosed={() => setChoice(null)}
          renderTrigger={() => null}
        />
      )}
    </>
  );
}
