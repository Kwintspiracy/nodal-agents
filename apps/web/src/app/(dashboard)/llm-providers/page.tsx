// LLM Providers — moved out of /settings into its own first-class sidebar
// entry (below /agents). The thinking: providers are a frequent setup task
// — first time an agent boots, every model swap, every provider rotation —
// and burying them three levels deep under Settings turned the most-used
// admin page into the hardest to find. The form components themselves
// (LlmKeysList / LlmKeyForm / LlmKeyRow) moved with the route; /settings
// keeps Auth / Security / Network / Session only.

import { listLlmKeysAction } from '@/lib/actions.ts';
import LlmKeysList from './LlmKeysList.tsx';

export const dynamic = 'force-dynamic';

export default async function LlmProvidersPage() {
  const result = await listLlmKeysAction();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">LLM Providers</h1>
        <p className="text-sm text-neutral-500 mt-0.5">
          Configure providers your agents can use. Each agent picks one provider and types its own
          model on top.
        </p>
      </div>

      {result.ok ? (
        <LlmKeysList initialRows={result.data} />
      ) : (
        <div className="bg-neutral-900 border border-red-900/40 rounded-xl px-6 py-4 text-sm text-red-300">
          {result.message}
        </div>
      )}
    </div>
  );
}
