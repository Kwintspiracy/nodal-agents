import figma from '@figma/code-connect';
import ModelToolsBadge from './ModelToolsBadge';

figma.connect(
  ModelToolsBadge,
  'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=31-19',
  {
    props: {
      support: figma.enum('Support', { yes: 'yes', no: 'no', unknown: 'unknown' }),
    },
    example: ({ support }) => <ModelToolsBadge support={support} />,
  },
);
