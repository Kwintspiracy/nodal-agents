import figma from '@figma/code-connect';
import TextButton from './TextButton';

figma.connect(TextButton, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=100-2', {
  example: () => <TextButton>Link</TextButton>,
});
