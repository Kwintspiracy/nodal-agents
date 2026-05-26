import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSkillByIdAction } from '@/lib/actions.ts';
import SkillForm from '../../SkillForm.tsx';

export const dynamic = 'force-dynamic';

export default async function EditSkillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getSkillByIdAction(id);
  if (!result.ok || !result.data) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/skills"
          className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
        >
          ← Skills
        </Link>
        <h1 className="text-2xl font-bold text-white mt-2">Edit skill</h1>
        <p className="text-sm text-neutral-500 mt-1">
          Changes apply to the next LLM call that uses this skill — no cache invalidation needed.
        </p>
      </div>

      <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-6">
        <SkillForm mode="edit" initial={result.data} />
      </div>
    </div>
  );
}
