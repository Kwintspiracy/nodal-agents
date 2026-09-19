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
 * #242 — son « Back to Skills » est parti avec tous les retours du produit
 * (Quentin, 19/09). Elle n'a rien à dire d'elle-même, donc pas de barre non
 * plus, et pas d'actions de page : le seul bouton qui agit est celui du
 * formulaire, dans le formulaire, là où il enregistre.
 */
export default function NewSkillPage() {
  return (
    <PageShell title="New skill" subtitle="Reusable instructions for any agent.">
      <SkillForm mode="create" defaultOpen />
    </PageShell>
  );
}
