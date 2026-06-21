import {
  getRootContextAction,
  getRootSystemPromptAction,
  getInstallNotesAction,
  listMemoriesAction,
} from '@/lib/actions.ts';
import RootContextClient from './RootContextClient.tsx';

export const dynamic = 'force-dynamic';

/**
 * /settings/root-context — "ROOT Agent Context".
 *
 * Surfaces EVERYTHING the ROOT agent is fed as system-prompt context — its
 * identity/personality, every attached skill's full markdown, the operator
 * install notes, and the persistent memories — and lets the user view + edit
 * each in one place. The runner reads these live per job, so edits take effect
 * on the next turn (no restart).
 */
export default async function RootContextPage() {
  const [ctxRes, promptRes, notesRes, memRes] = await Promise.all([
    getRootContextAction(),
    getRootSystemPromptAction(),
    getInstallNotesAction(),
    listMemoriesAction({}),
  ]);

  const ctx = ctxRes.ok
    ? ctxRes.data
    : { rootAgentId: null, rootName: null, personality: '', skills: [] };

  return (
    <RootContextClient
      rootName={ctx.rootName}
      systemPrompt={promptRes.ok ? promptRes.data : ''}
      personality={ctx.personality}
      skills={ctx.skills}
      installNotes={notesRes.ok ? notesRes.data : ''}
      memories={
        memRes.ok
          ? memRes.data.items.map((m) => ({ id: m.id, fact: m.fact, category: m.category }))
          : []
      }
    />
  );
}
