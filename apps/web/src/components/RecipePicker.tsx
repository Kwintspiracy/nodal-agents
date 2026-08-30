'use client';

import { useState, type ReactNode } from 'react';
import {
  agentRecipes,
  agentTeams,
  recipesOfTeam,
  type AgentRecipe,
  type RecipeSkillMeta,
} from '@nodal-agents/catalog';
import Modal, { ModalFooter } from './ui/Modal.tsx';
import PrimaryButton from './ui/PrimaryButton.tsx';
import Select from './ui/Select.tsx';
import StatusPill from './ui/StatusPill.tsx';
import { OptionRadio } from './ui/OptionRadio.tsx';
import { SetBlock } from './ui/SetBlock.tsx';
import RecipeDetail from './RecipeDetail.tsx';
import AgentForm from './AgentForm.tsx';
import type { AgentRow, LlmKeyUiRow } from '@/lib/actions.ts';
import type { RecipeConnectorMeta } from '@/lib/recipe-connectors.ts';

/**
 * RecipePicker — "Create New Agent", the first screen of agent creation.
 *
 * One column, as in the Figma mock (Modal 51:739): two labelled sections,
 * radio cards, a family select, Cancel / Next.
 *
 *   1. pick   — "Customize a new agent" (the empty form) first, then the
 *               pre-filled profiles of the selected FAMILY. The family select
 *               suggests a structure ("Development": lead, developer,
 *               reviewer) without building it — one agent per click. Each
 *               profile card carries real counts: skills attached, connectors
 *               recommended, read-only posture.
 *   2. detail — what THIS profile sets on the agent, item by item (RecipeDetail).
 *   3. form   — the ordinary create form, pre-filled.
 *
 * The word "recipe" never appears on screen. The counts are derived from the
 * recipe, never typed by hand, so the card cannot promise something the
 * creation does not apply.
 */

interface Props {
  llmKeys: LlmKeyUiRow[];
  agents: AgentRow[];
  /** From the server (recipeSkillMeta) — keeps the skill bodies out of the bundle. */
  skillMeta: Record<string, RecipeSkillMeta>;
  /** From the server (recipeConnectorMeta) — which recommended connectors this workspace has. */
  connectorMeta: Record<string, RecipeConnectorMeta>;
  /** Custom trigger; defaults to the "+ New agent" button. */
  renderTrigger?: (open: () => void) => ReactNode;
}

type Step =
  | { kind: 'closed' }
  | { kind: 'pick' }
  | { kind: 'detail'; recipe: AgentRecipe }
  | { kind: 'form'; recipe: AgentRecipe | undefined };

export default function RecipePicker({
  llmKeys,
  agents,
  skillMeta,
  connectorMeta,
  renderTrigger,
}: Props) {
  const [step, setStep] = useState<Step>({ kind: 'closed' });
  // 'scratch' or a recipe slug. Scratch is the default, as it always was.
  const [selected, setSelected] = useState<string>('scratch');
  const [teamSlug, setTeamSlug] = useState<string>(agentTeams[0]?.slug ?? '');

  const team = agentTeams.find((t) => t.slug === teamSlug);
  const shown = team ? recipesOfTeam(team) : agentRecipes;

  // Names already in the workspace — to INFORM, never to ask for completion.
  const existingNames = new Set(agents.map((a) => a.name.trim().toLowerCase()));
  const exists = (r: AgentRecipe) => existingNames.has(r.name.trim().toLowerCase());

  function open() {
    setSelected('scratch');
    setStep({ kind: 'pick' });
  }
  function next() {
    if (selected === 'scratch') {
      setStep({ kind: 'form', recipe: undefined });
      return;
    }
    const recipe = agentRecipes.find((r) => r.slug === selected);
    setStep(recipe ? { kind: 'detail', recipe } : { kind: 'pick' });
  }

  const trigger = renderTrigger ? (
    renderTrigger(open)
  ) : (
    <PrimaryButton variant="agent" onClick={open}>
      New agent
    </PrimaryButton>
  );

  return (
    <>
      {trigger}

      <Modal
        open={step.kind === 'pick'}
        onClose={() => setStep({ kind: 'closed' })}
        title="Create New Agent"
        className="max-w-[480px]"
        footer={
          <ModalFooter>
            <PrimaryButton
              variant="neutral"
              type="button"
              onClick={() => setStep({ kind: 'closed' })}
            >
              Cancel
            </PrimaryButton>
            <PrimaryButton variant="ink" type="button" onClick={next}>
              Next
            </PrimaryButton>
          </ModalFooter>
        }
      >
        <div role="radiogroup" aria-label="How to start" className="-mt-7">
          <SetBlock
            label="Default custom"
            lede="The empty agent configuration. You pick the tools, skills and autonomy yourself."
          >
            <div className="mt-3">
              <OptionRadio
                active={selected === 'scratch'}
                onClick={() => setSelected('scratch')}
                name="Customize a new agent"
                description="An empty form, pick everything as needed."
              />
            </div>
          </SetBlock>

          <SetBlock
            label="Pre-filled agent profiles"
            lede="A ready-to-use agent comes with a basic role-ready configuration you can customize further."
          >
            {agentTeams.length > 0 && (
              <Select
                aria-label="Profile family"
                value={teamSlug}
                onChange={(e) => setTeamSlug(e.target.value)}
                containerClassName="mt-3 mb-4"
              >
                {agentTeams.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}
            {team && (
              <p className="text-body-13 text-ink-3 mb-3">
                {team.shape} — a suggestion, not a package: each role is created on its own.
              </p>
            )}
            {shown.map((recipe) => {
              const skills = recipe.skills.filter((s) => skillMeta[s]).length;
              const connectors = (recipe.connectors ?? []).filter(
                (c) => connectorMeta[c.slug],
              ).length;
              const readOnly = recipe.presets?.includes('read-only') ?? false;
              return (
                <OptionRadio
                  key={recipe.slug}
                  active={selected === recipe.slug}
                  onClick={() => setSelected(recipe.slug)}
                  name={exists(recipe) ? `${recipe.name} · already here` : recipe.name}
                  description={recipe.summary}
                >
                  <span className="flex flex-wrap gap-1.5 mt-2">
                    <StatusPill variant="lvl-err" icon={null} label={`${skills} Skills`} />
                    {connectors > 0 && (
                      <StatusPill variant="run" icon={null} label={`${connectors} Connectors`} />
                    )}
                    {readOnly && <StatusPill variant="done" icon={null} label="Read-only" />}
                  </span>
                </OptionRadio>
              );
            })}
          </SetBlock>
        </div>
      </Modal>

      {step.kind === 'detail' && (
        <RecipeDetail
          recipe={step.recipe}
          skillMeta={skillMeta}
          connectorMeta={connectorMeta}
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
