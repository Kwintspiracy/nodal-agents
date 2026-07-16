import figma from '@figma/code-connect';
import PageHeader from './PageHeader';

figma.connect(PageHeader, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=147-3', {
  example: () => <PageHeader title="Agents" subtitle="Your fleet of autonomous minds." />,
});
