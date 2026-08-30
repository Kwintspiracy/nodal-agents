'use client';

import type { AgentRecipe, RecipeNeed, RecipeSkillMeta } from '@nodal-agents/catalog';
import type { RecipeConnectorMeta } from '@/lib/recipe-connectors.ts';
import Modal, { ModalFooter } from './ui/Modal.tsx';
import PrimaryButton from './ui/PrimaryButton.tsx';
import { MonoMicroTag } from './ui/MonoMicroTag.tsx';

/**
 * RecipeDetail — what makes this agent special, BEFORE it exists.
 *
 * The screen between choosing a profile and the create form. It lists, item by
 * item, everything the profile will set on the agent: the skills it attaches
 * (with their real descriptions from the catalog), the tools it blocks, the
 * autonomy posture, the model requirement, and what the user will still have
 * to provide. Without this screen the user picks "Developer", lands on the
 * ordinary form, and never learns why that agent is any different from one
 * made from scratch.
 *
 * Everything shown here is READ from the recipe and the catalog — nothing is
 * described that is not actually applied by createAgentAction's recipe path.
 */

/** Mirrors the five tools the reviewer preset blocks (actions.ts, READONLY_PRESET_TOOLS). */
const READ_ONLY_BLOCKED_TOOLS = [
  'file_write',
  'file_edit',
  'skill_file_write',
  'run_command',
  'run_skill_script',
] as const;

const NEED_COPY: Record<RecipeNeed, { title: string; detail: string }> = {
  workspace: {
    title: 'A folder of its own',
    detail:
      'Attach one from the agent’s Workspaces tab after creating it. Without a folder, an agent that writes code writes into the shared hand-off area instead.',
  },
  'code-runtime': {
    title: 'A way to run code',
    detail:
      'A coding CLI already installed and signed in on this machine (Claude Code, Codex), or a model called with an API key. No credentials are asked for or stored: an installed CLI runs under the session already open on this machine, like a terminal would.',
  },
};

const ROLE_COPY: Record<AgentRecipe['role'], string> = {
  worker: 'Worker — does the task itself, never delegates.',
  router: 'Orchestrator — takes a request and hands the pieces to the agents attached to it.',
  planner: 'Planner — plans the work, then orchestrates the agents attached to it.',
};

interface Props {
  recipe: AgentRecipe;
  /** Name/description/builtins of the catalog skills, computed on the server. */
  skillMeta: Record<string, RecipeSkillMeta>;
  /** Recommended connectors, with whether this workspace already has them. */
  connectorMeta: Record<string, RecipeConnectorMeta>;
  open: boolean;
  onBack: () => void;
  onContinue: () => void;
}

export default function RecipeDetail({
  recipe,
  skillMeta,
  connectorMeta,
  open,
  onBack,
  onContinue,
}: Props) {
  const skills = recipe.skills
    .map((slug) => skillMeta[slug])
    .filter((s): s is RecipeSkillMeta => s !== undefined);
  const readOnly = recipe.presets?.includes('read-only') ?? false;
  const needs = recipe.needs ?? [];
  const connectors = (recipe.connectors ?? [])
    .map((c) => connectorMeta[c.slug])
    .filter((c): c is RecipeConnectorMeta => c !== undefined);

  return (
    <Modal
      open={open}
      onClose={onBack}
      title={recipe.name}
      className="max-w-2xl"
      footer={
        <ModalFooter>
          <PrimaryButton variant="neutral" type="button" onClick={onBack}>
            Back
          </PrimaryButton>
          <PrimaryButton variant="ink" type="button" onClick={onContinue}>
            Continue
          </PrimaryButton>
        </ModalFooter>
      }
    >
      <p className="text-body-14 text-ink-2 leading-relaxed">{recipe.purpose}</p>

      <div className="mt-5 space-y-5">
        <Section label="Role">
          <p className="text-body-13 text-ink-2">{ROLE_COPY[recipe.role]}</p>
          {recipe.modelRequirements?.includes('tools') && (
            <p className="text-body-13 text-ink-3 mt-1">
              Needs a model that can call tools — the model list will only offer those.
            </p>
          )}
        </Section>

        <Section label={`Skills attached (${skills.length})`}>
          {skills.length === 0 ? (
            <p className="text-body-13 text-ink-3">None.</p>
          ) : (
            <ul className="space-y-2">
              {skills.map((s) => (
                <li key={s.slug} className="rounded-lg border border-rule-2 bg-paper px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-medium-13 text-ink">{s.name}</span>
                    <MonoMicroTag tone="skill">{s.slug}</MonoMicroTag>
                  </div>
                  <p className="text-body-13 text-ink-3 mt-1 leading-snug">{s.description}</p>
                  {s.requiredBuiltins.length > 0 && (
                    <p className="text-mono-11 text-ink-3 mt-1.5">
                      unlocks {s.requiredBuiltins.join(', ')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section label="Tools">
          {/* Read-only is NOT a tool change: the write tools stay in the list,
              the harness refuses the call. That is an approval rule — see
              Autonomy below, which is also where the editor shows it. */}
          <p className="text-body-13 text-ink-2">
            Nothing added or removed — tools come from the attached skills and the built-ins every
            agent has.
          </p>
        </Section>

        {connectors.length > 0 && (
          <Section label={`Connectors recommended (${connectors.length})`}>
            <ul className="space-y-2">
              {connectors.map((c) => (
                <li
                  key={c.slug}
                  className={`rounded-lg border px-3 py-2.5 ${
                    c.installed ? 'border-rule-2 bg-paper' : 'border-warn/40 bg-warn/5'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-medium-13 text-ink">{c.label}</span>
                    <MonoMicroTag tone="ink">{c.slug}</MonoMicroTag>
                  </div>
                  <p className="text-body-13 text-ink-3 mt-1 leading-snug">{c.description}</p>
                  <p className="text-body-13 text-ink-2 mt-1.5">
                    {c.installed ? (
                      <>
                        <span className="text-medium-13 text-ink">Ready.</span> Already in this
                        workspace — attached to the agent on creation.
                      </>
                    ) : c.needsApiKey ? (
                      <>
                        <span className="text-medium-13 text-ink">Needs an API key.</span> Add it
                        from Connectors with your key, then attach it to this agent.
                      </>
                    ) : (
                      <>
                        <span className="text-medium-13 text-ink">Not installed yet.</span> No API
                        key — add it from Connectors, then attach it to this agent.
                      </>
                    )}
                  </p>
                  {!c.installed && <p className="text-mono-11 text-ink-3 mt-1.5">{c.setupHint}</p>}
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section label="Autonomy">
          {readOnly ? (
            <>
              <p className="text-body-13 text-ink-2">
                <span className="text-medium-13 text-ink">Read-only agent: on.</span> The five write
                tools are blocked — the agent still sees them, the call is refused. This is the
                “Read-only agent” switch of the editor’s Autonomy tab, where each block also shows
                per tool and can be turned off any time.
              </p>
              <p className="text-mono-11 text-ink-3 mt-1.5">
                blocked: {READ_ONLY_BLOCKED_TOOLS.join(', ')}
              </p>
              <p className="text-body-13 text-ink-3 mt-1.5">
                Everything else uses the workspace default, as for any new agent.
              </p>
            </>
          ) : (
            <p className="text-body-13 text-ink-2">
              Uses the workspace default, as every new agent does. You can change it per agent after
              creation, in the editor’s Autonomy tab.
            </p>
          )}
        </Section>

        {needs.length > 0 && (
          <Section label="You will still need to provide">
            <ul className="space-y-2">
              {needs.map((n) => (
                <li key={n} className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-2.5">
                  <span className="block text-medium-13 text-ink">{NEED_COPY[n].title}</span>
                  <span className="block text-body-13 text-ink-3 mt-0.5 leading-snug">
                    {NEED_COPY[n].detail}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>

      <p className="text-body-13 text-ink-3 mt-5">
        Next: the usual agent form, pre-filled. Everything above is applied once you create the
        agent, and stays editable afterwards — the agent is an ordinary one.
      </p>
    </Modal>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-mono-11-caps text-ink-3 mb-2">{label}</h3>
      {children}
    </section>
  );
}
