// Une fixture, pour la lire : le texte d'un fichier texte, sinon sa taille et un lien de téléchargement.
import { readFixture } from '@nodal-agents/bench/studio';
import Banner from '@/components/ui/Banner';
import CodeBlock from '@/components/ui/CodeBlock';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { assertStudioPage } from '@/lib/bench-studio/server';
import StudioPage from '../_components/StudioPage';
import { bytes } from '../_components/format';

export const dynamic = 'force-dynamic';

export default async function FixturePage({
  searchParams,
}: {
  searchParams: Promise<{ path?: string }>;
}) {
  await assertStudioPage();
  const path = (await searchParams).path ?? '';
  let file: ReturnType<typeof readFixture> | null = null;
  let problem: string | null = null;
  try {
    file = readFixture(path);
  } catch (e) {
    problem = String(e instanceof Error ? e.message : e);
  }
  return (
    <StudioPage
      title={path.split('/').pop() || 'Fixture'}
      subtitle={<span className="font-mono">packages/bench/fixtures/{path}</span>}
      actions={
        file && (
          <PrimaryButton
            href={`/bench-studio/api/fixture?path=${encodeURIComponent(path)}`}
            variant="neutral"
            size="sm"
            download
          >
            Download
          </PrimaryButton>
        )
      }
    >
      {problem !== null || file === null ? (
        <Banner variant="warn">{problem}</Banner>
      ) : file.kind === 'text' ? (
        <CodeBlock
          code={file.text}
          lang={path.split('.').pop() ?? null}
          filename={path}
          className=""
        />
      ) : (
        <Banner variant="info" title="Binary file">
          A {file.type.toUpperCase()} file of {bytes(file.bytes)}. Download it to open it in its
          application.
        </Banner>
      )}
    </StudioPage>
  );
}
