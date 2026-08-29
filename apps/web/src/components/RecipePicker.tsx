'use client';

import { useState, type ReactNode } from 'react';
import { agentRecipes, agentTeams, recipesOfTeam, type AgentRecipe } from '@nodal-agents/catalog';
import Modal, { ModalFooter } from './ui/Modal.tsx';
import PrimaryButton from './ui/PrimaryButton.tsx';
import RecipeTile from './ui/RecipeTile.tsx';
import RecipeDetail from './RecipeDetail.tsx';
import AgentForm from './AgentForm.tsx';
import type { AgentRow, LlmKeyUiRow } from '@/lib/actions.ts';

/**
 * RecipePicker — "What should this agent do?"
 *
 * The first screen of agent creation. Three steps, each one modal:
 *
 *   1. pick   — "Start from scratch" FIRST (the default, as before), then the
 *               profiles that ship with the product. Teams are a discreet
 *               footnote: a name and a shape that teach what tends to work,
 *               never the main option and never a button that builds them.
 *   2. detail — what THIS profile sets on the agent: skills, blocked tools,
 *               autonomy, what the user still has to provide. Without it the
 *               user lands on the ordinary form and never learns what makes
 *               the agent special.
 *   3. form   — the ordinary create form, pre-filled. One agent.
 *
 * The word "recipe" never appears on screen: the user sees a question and
 * choices. The term lives in code and in the catalog only.
 */

interface Props {
  llmKeys: LlmKeyUiRow[];
  agents: AgentRow[];
  /** Custom trigger; defaults to the "+ New agent" button. */
  renderTrigger?: (open: () => void) => ReactNode;
}

type Step =
  | { kind: 'closed' }
  | { kind: 'pick' }
  | { kind: 'detail'; recipe: AgentRecipe }
  | { kind: 'form'; recipe: AgentRecipe | undefined };

export default function RecipePicker({ llmKeys, agents, renderTrigger }: Props) {
  const [step, setStep] = useState<Step>({ kind: 'closed' });

  // Names already in the workspace, so a profile whose agent exists is marked
  // as such — to INFORM ("you have one"), never to ask for completion.
  const existingNames = new Set(agents.map((a) => a.name.trim().toLowerCase()));
  const exists = (r: AgentRecipe) => existingNames.has(r.name.trim().toLowerCase());

  const trigger = renderTrigger ? (
    renderTrigger(() => setStep({ kind: 'pick' }))
  ) : (
    <PrimaryButton variant="agent" onClick={() => setStep({ kind: 'pick' })}>
      New agent
    </PrimaryButton>
  );

  const alreadyBadge = (
    <span className="font-mono text-[9.5px] uppercase tracking-wider text-ink-3">already here</span>
  );

  return (
    <>
      {trigger}

      <Modal
        open={step.kind === 'pick'}
        onClose={() => setStep({ kind: 'closed' })}
        title="What should this agent do?"
        className="max-w-2xl"
        footer={
          <ModalFooter>
            <PrimaryButton
              variant="neutral"
              type="button"
              onClick={() => setStep({ kind: 'closed' })}
            >
              Cancel
            </PrimaryButton>
          </ModalFooter>
        }
      >
        <div className="space-y-5">
          <RecipeTile
            onClick={() => setStep({ kind: 'form', recipe: undefined })}
            title="Start from scratch"
            description="The empty form. Pick a model, write its instructions, attach skills later."
          />

          <section aria-label="Profiles">
            <h3 className="text-mono-11-caps text-ink-3 mb-1">Or start from a profile</h3>
            <p className="text-body-13 text-ink-3 mb-2.5">
              A profile pre-fills the form and attaches what that kind of agent needs. You see
              exactly what it sets before creating anything.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {agentRecipes.map((recipe) => (
                <RecipeTile
                  key={recipe.slug}
                  onClick={() => setStep({ kind: 'detail', recipe })}
                  title={recipe.name}
                  description={recipe.summary}
                  tags={recipe.kit}
                  muted={exists(recipe)}
                  badge={exists(recipe) ? alreadyBadge : undefined}
                />
              ))}
            </div>
          </section>

          {agentTeams.length > 0 && (
            <section aria-label="Teams" className="border-t border-rule-2 pt-4">
              <h3 className="text-mono-11-caps text-ink-3 mb-1">How these fit together</h3>
              {agentTeams.map((team) => (
                <div key={team.slug} className="mt-1.5">
                  <p className="text-body-13 text-ink-2">
                    <span className="text-medium-13 text-ink">{team.name}</span>
                    <span className="font-mono text-[11px] text-ink-3 ml-2">{team.shape}</span>
                  </p>
                  <p className="text-body-13 text-ink-3 mt-0.5 max-w-prose">{team.rationale}</p>
                  <p className="text-body-12 text-ink-3 mt-0.5">
                    A suggestion, not a package: each role is created on its own, in any order —{' '}
                    {recipesOfTeam(team)
                      .map((r) => r.name)
                      .join(', ')}
                    .
                  </p>
                </div>
              ))}
            </section>
          )}
        </div>
      </Modal>

      {step.kind === 'detail' && (
        <RecipeDetail
          recipe={step.recipe}
          open
          onBack={() => setStep({ kind: 'pick' })}
          onContinue={() => setStep({ kind: 'form', recipe: step.recipe })}
        />
      )}

      {step.kind === 'form' && (
        <AgentForm
          key={step.recipe?.slug ?? 'scratch'}
          llmKeys={llmKeys}
          agents={agents}
          recipe={step.recipe}
          openInitially
          onClosed={() => setStep({ kind: 'closed' })}
          renderTrigger={() => null}
        />
      )}
    </>
  );
}
