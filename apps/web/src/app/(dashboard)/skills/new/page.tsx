import BackButton from '@/components/ui/BackButton';
import SkillForm from '../SkillForm.tsx';

/**
 * /skills/new — dedicated route for the Create-skill flow.
 *
 * The page-level entry point matches the design's "Create skill" CTA in
 * the PageTopBar without needing a modal. The existing SkillForm
 * component renders inline in create mode (auto-opens here because we
 * wrap it without the collapsing trigger).
 */
export default function NewSkillPage() {
  return (
    <div className="py-7">
      <BackButton href="/skills" label="Back to Skills" />
      <h1 className="mt-2 text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
        New skill
      </h1>
      <p className="mt-1.5 text-[14px] leading-[1.5] text-ink-3">
        Skills are reusable instructions appended to an agent&apos;s system prompt when assigned.
      </p>
      <div className="mt-5">
        <SkillForm mode="create" defaultOpen />
      </div>
    </div>
  );
}
