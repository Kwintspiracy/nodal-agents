'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  updateRootPersonalityAction,
  updateSkillAction,
  setInstallNotesAction,
  deleteMemoryAction,
} from '@/lib/actions.ts';
import PrimaryButton from '@/components/ui/PrimaryButton';

/**
 * RootContextClient — view + edit every piece of context the ROOT agent is fed:
 * identity/personality, each attached skill's full markdown, install notes, and
 * persistent memories. Edits are read live by the runner on the next turn.
 */

type Skill = { id: string; name: string; description: string | null; content: string };
type Memory = { id: string; fact: string; category: string };

const TEXTAREA =
  'mt-2 w-full rounded-md border border-rule-2 bg-canvas px-3 py-2.5 font-mono text-[12px] leading-[1.55] text-ink';

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-ink-4">{children}</div>
  );
}

export default function RootContextClient({
  rootName,
  systemPrompt,
  personality: initialPersonality,
  skills,
  installNotes: initialNotes,
  memories: initialMemories,
}: {
  rootName: string | null;
  systemPrompt: string;
  personality: string;
  skills: Skill[];
  installNotes: string;
  memories: Memory[];
}) {
  const [personality, setPersonality] = useState(initialPersonality);
  const [savingP, setSavingP] = useState(false);
  const [notes, setNotes] = useState(initialNotes);
  const [savingN, setSavingN] = useState(false);
  const [skillContent, setSkillContent] = useState<Record<string, string>>(
    Object.fromEntries(skills.map((s) => [s.id, s.content])),
  );
  const [savingSkill, setSavingSkill] = useState<string | null>(null);
  const [openSkills, setOpenSkills] = useState<Record<string, boolean>>({});
  const [memories, setMemories] = useState<Memory[]>(initialMemories);

  async function savePersonality() {
    setSavingP(true);
    const res = await updateRootPersonalityAction({ personality });
    setSavingP(false);
    toast[res.ok ? 'success' : 'error'](res.ok ? 'Personality saved' : res.message);
  }

  async function saveNotes() {
    setSavingN(true);
    const res = await setInstallNotesAction(notes);
    setSavingN(false);
    toast[res.ok ? 'success' : 'error'](res.ok ? 'Install notes saved' : res.message);
  }

  async function saveSkill(s: Skill) {
    setSavingSkill(s.id);
    const res = await updateSkillAction({
      id: s.id,
      name: s.name,
      description: s.description ?? undefined,
      content: skillContent[s.id] ?? '',
    });
    setSavingSkill(null);
    toast[res.ok ? 'success' : 'error'](res.ok ? `Saved "${s.name}"` : res.message);
  }

  async function removeMemory(id: string) {
    const res = await deleteMemoryAction(id);
    if (res.ok) {
      setMemories((m) => m.filter((x) => x.id !== id));
      toast.success('Memory removed');
    } else {
      toast.error(res.message);
    }
  }

  return (
    <div className="py-7">
      <h1 className="text-[28px] font-semibold tracking-[-0.015em] text-ink">ROOT Agent Context</h1>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-[1.5] text-ink-3">
        Everything {rootName ?? 'your ROOT agent'} is fed as system-prompt context. Edits are read
        live by the runner on the next turn — no restart needed.
      </p>

      {!rootName ? (
        <div className="mt-6 rounded-xl border border-rule-2 bg-paper p-5 text-[13px] text-ink-3">
          No ROOT agent yet. Create your first agent — the workspace&apos;s origin orchestrator
          becomes the ROOT.
        </div>
      ) : (
        <div className="mt-7 flex flex-col gap-9">
          {/* Full assembled system prompt — the real artifact */}
          <section>
            <SectionLabel>Full system prompt — exactly what {rootName} receives</SectionLabel>
            <p className="mt-1 text-[12px] text-ink-3">
              The complete context assembled per turn: identity, personality, runtime, built-in
              capabilities, workspaces, memory, and every skill. Read-only — edit the pieces below.
            </p>
            <textarea
              readOnly
              value={systemPrompt}
              rows={18}
              className="mt-2 w-full rounded-md border border-rule-2 bg-canvas px-3 py-2.5 font-mono text-[11.5px] leading-[1.5] text-ink-2"
            />
          </section>

          {/* Identity / personality */}
          <section>
            <SectionLabel>Identity &amp; personality</SectionLabel>
            <textarea
              value={personality}
              onChange={(e) => setPersonality(e.target.value)}
              rows={12}
              className={TEXTAREA}
            />
            <div className="mt-2 flex justify-end">
              <PrimaryButton onClick={savePersonality} size="sm">
                {savingP ? 'Saving…' : 'Save personality'}
              </PrimaryButton>
            </div>
          </section>

          {/* Skills */}
          <section>
            <SectionLabel>Skills ({skills.length})</SectionLabel>
            <p className="mt-1 text-[12px] text-ink-3">
              Each skill&apos;s full markdown is injected into the prompt. Edit here to change how
              the agent behaves.
            </p>
            <div className="mt-3 flex flex-col gap-2.5">
              {skills.map((s) => {
                const open = !!openSkills[s.id];
                return (
                  <div
                    key={s.id}
                    className="overflow-hidden rounded-xl border border-rule-2 bg-paper"
                  >
                    <button
                      type="button"
                      onClick={() => setOpenSkills((o) => ({ ...o, [s.id]: !o[s.id] }))}
                      className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-hover"
                    >
                      <span className="w-3 shrink-0 text-[11px] text-ink-4">
                        {open ? '▾' : '▸'}
                      </span>
                      <span className="shrink-0 text-[13.5px] font-semibold text-ink">
                        {s.name}
                      </span>
                      {s.description && (
                        <span className="min-w-0 truncate text-[12px] text-ink-3">
                          — {s.description}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-4">
                        {(skillContent[s.id] ?? '').length} chars
                      </span>
                    </button>
                    {open && (
                      <div className="px-4 pb-4">
                        <textarea
                          value={skillContent[s.id] ?? ''}
                          onChange={(e) =>
                            setSkillContent((prev) => ({ ...prev, [s.id]: e.target.value }))
                          }
                          rows={12}
                          className={TEXTAREA}
                        />
                        <div className="mt-2 flex justify-end">
                          <PrimaryButton onClick={() => saveSkill(s)} size="sm">
                            {savingSkill === s.id ? 'Saving…' : 'Save'}
                          </PrimaryButton>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {skills.length === 0 && (
                <div className="text-[12.5px] text-ink-4">No skills attached.</div>
              )}
            </div>
          </section>

          {/* Install notes */}
          <section>
            <SectionLabel>Install notes (Runtime block)</SectionLabel>
            <p className="mt-1 text-[12px] text-ink-3">
              Operator notes about this machine (endpoints, model names, paths) — injected into
              every agent&apos;s ## Runtime block.
            </p>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={6}
              placeholder="e.g. ComfyUI runs on port 8000; substitute models, don't block."
              className={TEXTAREA}
            />
            <div className="mt-2 flex justify-end">
              <PrimaryButton onClick={saveNotes} size="sm">
                {savingN ? 'Saving…' : 'Save notes'}
              </PrimaryButton>
            </div>
          </section>

          {/* Memories */}
          <section>
            <SectionLabel>Persistent memory ({memories.length})</SectionLabel>
            <p className="mt-1 text-[12px] text-ink-3">
              Durable facts injected into the prompt. Remove anything stale or wrong.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {memories.map((m) => (
                <div
                  key={m.id}
                  className="flex items-start gap-3 rounded-lg border border-rule-2 bg-paper px-3.5 py-2.5"
                >
                  <span className="mt-0.5 shrink-0 rounded bg-conn-vivid/12 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-3">
                    {m.category}
                  </span>
                  <span className="min-w-0 flex-1 text-[13px] leading-[1.5] text-ink">
                    {m.fact}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeMemory(m.id)}
                    className="shrink-0 text-[12px] text-ink-3 transition-colors hover:text-warn"
                  >
                    Remove
                  </button>
                </div>
              ))}
              {memories.length === 0 && (
                <div className="text-[12.5px] text-ink-4">No memories yet.</div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
