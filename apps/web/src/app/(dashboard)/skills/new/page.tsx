import WorkBar from '@/components/ui/WorkBar';
import PageShell from '@/components/ui/PageShell';
import SkillForm from '../SkillForm.tsx';

/**
 * /skills/new — dedicated route for the Create-skill flow.
 *
 * The page-level entry point matches the design's "Create skill" CTA in
 * the PageTopBar without needing a modal. The existing SkillForm
 * component renders inline in create mode (auto-opens here because we
 * wrap it without the collapsing trigger).
 *
 * #242 — une page de création est une page de détail : elle porte la WorkBar
 * comme les autres. Son retour y vit, et nulle part ailleurs. Elle n'a pas
 * d'actions de page : le seul bouton qui agit est celui du formulaire, dans le
 * formulaire, là où il enregistre.
 */
export default function NewSkillPage() {
  return (
    <PageShell
      title="New skill"
      subtitle="Reusable instructions for any agent."
      toolbarBleed
      toolbar={<WorkBar back={{ label: 'Back to Skills', parent: '/skills' }} />}
    >
      <SkillForm mode="create" defaultOpen />
    </PageShell>
  );
}
