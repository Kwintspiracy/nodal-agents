import figma from '@figma/code-connect';
import RowActionButton from './RowActionButton';

figma.connect(
  RowActionButton,
  'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=119-38',
  {
    props: {
      tone: figma.enum('Tone', { default: 'default', danger: 'danger', success: 'success' }),
    },
    example: ({ tone }) => (
      <RowActionButton tone={tone} onClick={() => {}}>
        Assign
      </RowActionButton>
    ),
  },
);
