import figma from '@figma/code-connect';
import Disc from './Disc';

figma.connect(Disc, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=52-33', {
  props: {
    variant: figma.enum('Variant', {
      agent: 'agent',
      skill: 'skill',
      conn: 'conn',
      ink: 'ink',
      neutral: 'neutral',
    }),
    shape: figma.enum('Shape', { round: 'round', square: 'square' }),
  },
  example: ({ variant, shape }) => (
    <Disc variant={variant} shape={shape}>
      <span />
    </Disc>
  ),
});
