import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-neutral-950 px-4">
      <div className="text-center space-y-4">
        <h1 className="text-2xl font-bold text-white">404 — Page not found</h1>
        <p className="text-sm text-neutral-400">This page doesn&apos;t exist.</p>
        <Link
          href="/stats"
          className="inline-block rounded-lg bg-emerald-500 text-black px-4 py-2 text-sm font-semibold hover:bg-emerald-400 transition-colors"
        >
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
