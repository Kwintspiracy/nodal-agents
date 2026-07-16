import figma from '@figma/code-connect';
import TextInput from './TextInput';

figma.connect(TextInput, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=26-13', {
  example: () => <TextInput placeholder="Search agents…" />,
});
