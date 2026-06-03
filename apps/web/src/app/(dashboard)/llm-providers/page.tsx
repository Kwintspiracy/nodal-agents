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
    <div className="py-7">
      <div className="mb-6">
        <h1 className="text-[28px] font-semibold tracking-[-0.015em] text-ink">LLM Providers</h1>
        <p className="mt-1.5 text-[13px] leading-[1.5] text-ink-3">
          Enter the API key for each provider you want to use. Agents pick the provider and model.
        </p>
      </div>

      {result.ok ? (
        <LlmKeysList initialRows={result.data} />
      ) : (
        <div className="rounded-xl border border-warn/40 bg-warn-bg px-6 py-4 text-sm text-warn">
          {result.message}
        </div>
      )}
    </div>
  );
}
