import figma from '@figma/code-connect';
import MemoryCategoryChip from './MemoryCategoryChip';

figma.connect(
  MemoryCategoryChip,
  'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=45-19',
  {
    props: {
      category: figma.enum('Category', {
        preference: 'preference',
        context: 'context',
        outcome: 'outcome',
        learned_rule: 'learned_rule',
      }),
    },
    example: ({ category }) => <MemoryCategoryChip category={category} />,
  },
);
