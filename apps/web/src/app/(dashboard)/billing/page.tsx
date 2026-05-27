import Link from 'next/link';

export default function BillingPage() {
  return (
    <div className="py-7">
      <div className="mb-5">
        <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
          Billing
        </h1>
        <p className="mt-1.5 text-[13px] leading-[1.5] text-ink-3">
          Self-hosted — no billing on this install
        </p>
      </div>

      <div className="space-y-4 rounded-2xl border border-rule-2 bg-paper px-6 py-5">
        <h2 className="text-base font-semibold text-ink">You run Nodal-Agents yourself</h2>
        <p className="text-[13.5px] leading-relaxed text-ink-3">
          This dashboard talks to your local Postgres and your local runner. Nodal-Agents
          doesn&apos;t charge you anything — your only cost is whatever your LLM provider bills
          (zero on local Ollama / LM Studio / llama.cpp; pay-as-you-go on remote APIs like Anthropic
          or OpenAI).
        </p>
        <p className="text-[13.5px] leading-relaxed text-ink-3">
          Per-agent token usage is on the{' '}
          <Link
            href="/stats"
            className="font-medium text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink-3"
          >
            Stats page
          </Link>
          . Multiply by your provider&apos;s price-per-token to estimate spend.
        </p>
      </div>

      <div className="mt-4 space-y-2 rounded-2xl border border-rule-2 bg-canvas px-6 py-5 text-xs text-ink-3">
        <strong className="block text-ink-2">Hosted SaaS later</strong>
        <p className="leading-relaxed">
          A managed cloud version of Nodal-Agents is on the roadmap. When it ships it will have real
          billing here. Until then this page is a placeholder.
        </p>
      </div>
    </div>
  );
}
