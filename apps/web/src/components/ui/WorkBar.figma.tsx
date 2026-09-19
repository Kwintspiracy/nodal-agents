import figma from '@figma/code-connect';
import WorkBar from './WorkBar';

figma.connect(WorkBar, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=353-3378', {
  example: () => <WorkBar back={{ label: 'Back to chat', parent: '/chat' }} />,
});
