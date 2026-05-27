import { listSkillsAction } from '@/lib/actions.ts';
import SkillsClient from './SkillsClient.tsx';

export const dynamic = 'force-dynamic';

/**
 * Skills page — composes the design system's two-tab pattern (Assigned
 * table + Library card grid). All interactive state (tab, search, modal)
 * lives in the client shell; the server side just delivers the row list.
 */
export default async function SkillsPage() {
  const result = await listSkillsAction();

  if (!result.ok) {
    return (
      <div className="py-7">
        <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
          Skills
        </h1>
        <div className="mt-4 rounded-2xl border border-warn/40 bg-warn-bg p-5 text-sm text-warn">
          {result.message}
        </div>
      </div>
    );
  }

  return <SkillsClient skills={result.data} />;
}
