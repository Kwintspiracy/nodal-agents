import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-canvas px-4">
      <div className="text-center space-y-4">
        <h1 className="text-2xl font-bold text-ink">404 — Page not found</h1>
        <p className="text-sm text-ink-3">This page doesn&apos;t exist.</p>
        <Link
          href="/"
          className="inline-block rounded-lg bg-agent-vivid text-canvas px-4 py-2 text-sm font-semibold hover:bg-agent-vivid transition-colors"
        >
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
