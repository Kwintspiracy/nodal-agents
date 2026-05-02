import Link from 'next/link';

export default function BillingPage() {
  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-white">Billing</h1>
        <p className="text-sm text-neutral-500 mt-0.5">Self-hosted — no billing on this install</p>
      </div>

      <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-6 py-5 space-y-3">
        <h2 className="text-base font-semibold text-white">You run NodalAI yourself</h2>
        <p className="text-sm text-neutral-400 leading-relaxed">
          This dashboard talks to your local Postgres and your local runner. NodalAI doesn't
          charge you anything — your only cost is whatever your LLM provider bills (zero on
          local Ollama / LM Studio / llama.cpp; pay-as-you-go on remote APIs like Anthropic
          or OpenAI).
        </p>
        <p className="text-sm text-neutral-400 leading-relaxed">
          Per-agent token usage is on the{' '}
          <Link href="/stats" className="text-white underline hover:no-underline">
            Stats page
          </Link>
          . Multiply by your provider's price-per-token to estimate spend.
        </p>
      </div>

      <div className="bg-neutral-950 border border-neutral-800/40 rounded-xl px-6 py-5 space-y-2 text-xs text-neutral-500">
        <strong className="text-neutral-300 block">Hosted SaaS later</strong>
        <p>
          A managed cloud version of NodalAI is on the roadmap. When it ships it will have
          real billing here. Until then this page is a placeholder.
        </p>
      </div>
    </div>
  );
}
