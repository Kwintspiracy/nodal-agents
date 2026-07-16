import figma from '@figma/code-connect';
import { ProBadge } from './StageBadge';

figma.connect(ProBadge, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=31-10', {
  example: () => <ProBadge />,
});
