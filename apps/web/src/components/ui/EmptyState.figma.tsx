import figma from '@figma/code-connect';
import EmptyState from './EmptyState';

figma.connect(EmptyState, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=51-3', {
  example: () => <EmptyState title="Nothing here yet" description="Create your first item." />,
});
