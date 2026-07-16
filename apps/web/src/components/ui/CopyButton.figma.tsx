import figma from '@figma/code-connect';
import CopyButton from './CopyButton';

figma.connect(CopyButton, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=94-10', {
  example: () => <CopyButton value="/path/to/thing" />,
});
