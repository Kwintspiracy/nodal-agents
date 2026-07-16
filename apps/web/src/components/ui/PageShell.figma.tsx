import figma from '@figma/code-connect';
import PageShell from './PageShell';

figma.connect(PageShell, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=206-41', {
  example: () => (
    <PageShell title="Page title" subtitle="One line lede.">
      {null}
    </PageShell>
  ),
});
