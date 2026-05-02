import { listSkillsAction } from '@/lib/actions.ts';
import SkillForm from './SkillForm.tsx';
import SkillRow from './SkillRow.tsx';

export const dynamic = 'force-dynamic';

export default async function SkillsPage() {
  const result = await listSkillsAction();

  if (!result.ok) {
    return (
      <div className="space-y-6 max-w-4xl">
        <h1 className="text-2xl font-bold text-white">Skills</h1>
        <div className="bg-neutral-900 border border-red-900/40 rounded-xl px-6 py-8 text-sm text-red-300">
          {result.message}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Skills</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            {result.data.length} skill{result.data.length === 1 ? '' : 's'} · reusable
            instructions you can attach to any agent
          </p>
        </div>
      </div>

      <SkillForm />

      {result.data.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-6 py-12 text-center text-neutral-600 text-sm">
          No skills yet. Create one above — the instructions get appended to the agent's
          system prompt when assigned.
        </div>
      ) : (
        <div className="space-y-3">
          {result.data.map((s) => (
            <SkillRow key={s.id} skill={s} />
          ))}
        </div>
      )}
    </div>
  );
}
