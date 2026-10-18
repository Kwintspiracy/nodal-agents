// Un fichier laissé par un essai, cherché dans les dossiers de travail que la base déclare.
import { assertStudioPage, studioRuntime } from '@/lib/bench-studio/server';
import Banner from '@/components/ui/Banner';
import CodeBlock from '@/components/ui/CodeBlock';
import PrimaryButton from '@/components/ui/PrimaryButton';
import StudioPage from '../_components/StudioPage';
import { bytes } from '../_components/format';

export const dynamic = 'force-dynamic';

export default async function DeliverablePage({
  searchParams,
}: {
  searchParams: Promise<{ path?: string }>;
}) {
  await assertStudioPage();
  const path = (await searchParams).path ?? '';
  let found: Awaited<ReturnType<ReturnType<typeof studioRuntime>['deliverable']>> | null = null;
  let problem: string | null = null;
  try {
    found = await studioRuntime().deliverable(path);
  } catch (e) {
    problem = String(e instanceof Error ? e.message : e);
  }
  return (
    <StudioPage
      title={path.split('/').pop() || 'Deliverable'}
      subtitle={<span className="font-mono">{found ? `${found.root}/${path}` : path}</span>}
      actions={
        found && (
          <PrimaryButton
            href={`/bench-studio/api/deliverable?path=${encodeURIComponent(path)}`}
            variant="neutral"
            size="sm"
            download
          >
            Download
          </PrimaryButton>
        )
      }
    >
      {problem !== null || found === null ? (
        <Banner variant="warn">{problem}</Banner>
      ) : found.kind === 'text' ? (
        <CodeBlock
          code={found.text}
          lang={path.split('.').pop() ?? null}
          filename={path}
          className=""
        />
      ) : (
        <Banner variant="info" title="Binary file">
          A {found.type.toUpperCase()} file of {bytes(found.bytes)}. Download it to open it in its
          application.
        </Banner>
      )}
    </StudioPage>
  );
}
