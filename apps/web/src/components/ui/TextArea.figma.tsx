import figma from '@figma/code-connect';
import TextArea from './TextArea';

figma.connect(TextArea, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=106-10', {
  example: () => <TextArea placeholder="Describe the task…" />,
});
