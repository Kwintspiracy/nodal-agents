// LLM Providers — moved out of /settings into its own first-class sidebar
// entry (below /agents). The thinking: providers are a frequent setup task
// — first time an agent boots, every model swap, every provider rotation —
// and burying them three levels deep under Settings turned the most-used
// admin page into the hardest to find. The form components themselves
// (LlmKeysList / LlmKeyForm / LlmKeyRow) moved with the route; /settings
// keeps Auth / Security / Network / Session only.

import { listLlmKeysAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import LlmKeysList from './LlmKeysList.tsx';

export const dynamic = 'force-dynamic';

export default async function LlmProvidersPage() {
  const result = await listLlmKeysAction();

  // On error, render the shell here; on success, LlmKeysList owns the shell so
  // its "New provider" CTA can live in the toolbar (right, above content).
  if (!result.ok) {
    return (
      <PageShell title="LLM Providers" subtitle="API keys for your model providers.">
        <div className="rounded-xl border border-warn/40 bg-warn-bg px-6 py-4 text-sm text-warn">
          {result.message}
        </div>
      </PageShell>
    );
  }

  return <LlmKeysList initialRows={result.data} />;
}
