import figma from '@figma/code-connect';
import BackButton from './BackButton';

figma.connect(BackButton, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=93-10', {
  example: () => <BackButton href="/agents" label="Back" />,
});
