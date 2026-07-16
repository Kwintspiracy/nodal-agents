import figma from '@figma/code-connect';
import Checkbox from './Checkbox';

figma.connect(Checkbox, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=107-22', {
  props: {
    tone: figma.enum('Tone', {
      ink: 'ink',
      agent: 'agent',
      skill: 'skill',
      connector: 'connector',
    }),
  },
  example: ({ tone }) => <Checkbox tone={tone} label="Enable" />,
});
