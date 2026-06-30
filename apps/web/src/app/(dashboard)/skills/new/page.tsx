import BackButton from '@/components/ui/BackButton';
import PageShell from '@/components/ui/PageShell';
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
    <PageShell title="New skill" subtitle="Reusable instructions for any agent.">
      <BackButton href="/skills" label="Back to Skills" />
      <div className="mt-5">
        <SkillForm mode="create" defaultOpen />
      </div>
    </PageShell>
  );
}
