import figma from '@figma/code-connect';
import VividStatCard from './VividStatCard';

figma.connect(VividStatCard, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=56-15', {
  props: {
    variant: figma.enum('Variant', { agent: 'agent', skill: 'skill', conn: 'conn' }),
  },
  example: ({ variant }) => <VividStatCard variant={variant} label="Runs" value="12" />,
});
