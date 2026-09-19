import { notFound } from 'next/navigation';
import { getSkillByIdAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import BackButton from '@/components/ui/BackButton';
import SkillForm from '../../SkillForm.tsx';

export const dynamic = 'force-dynamic';

export default async function EditSkillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getSkillByIdAction(id);
  if (!result.ok || !result.data) notFound();

  return (
    <PageShell title="Edit skill" subtitle={result.data.name}>
      <div className="space-y-6">
        <div>
          {/* #232 — la liste des skills est le PARENT de cette page ; on y
              retombe seulement quand cet onglet n'a pas de page précédente. */}
          <BackButton parent="/skills" label="Skills" className="text-xs hover:text-ink-2" />
          <p className="text-sm text-ink-3 mt-2">
            Changes apply to the next LLM call that uses this skill — no cache invalidation needed.
          </p>
        </div>

        <div className="bg-paper border border-rule-2 rounded-xl p-6">
          <SkillForm mode="edit" initial={result.data} />
        </div>
      </div>
    </PageShell>
  );
}
