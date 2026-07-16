import figma from '@figma/code-connect';
import TypeChip from './TypeChip';

figma.connect(TypeChip, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=45-9', {
  props: {
    variant: figma.enum('Variant', { agent: 'agent', skill: 'skill', conn: 'conn' }),
    label: figma.string('Label'),
  },
  example: ({ variant, label }) => <TypeChip variant={variant} label={label} />,
});
