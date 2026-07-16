import figma from '@figma/code-connect';
import StageBadge from './StageBadge';

figma.connect(StageBadge, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=31-9', {
  props: {
    stage: figma.enum('Stage', { Stable: 'stable', Beta: 'beta', Review: 'review' }),
  },
  example: ({ stage }) => <StageBadge stage={stage} />,
});
