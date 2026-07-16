import figma from '@figma/code-connect';
import FieldLabel from './FieldLabel';

figma.connect(FieldLabel, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=100-4', {
  example: () => <FieldLabel>Name</FieldLabel>,
});
