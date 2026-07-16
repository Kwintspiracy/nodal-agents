import figma from '@figma/code-connect';
import { OptionRadio } from './OptionRadio';

figma.connect(OptionRadio, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=105-40', {
  props: {
    active: figma.enum('State', { Default: false, Hover: false, Active: true }),
    name: figma.string('Name'),
    description: figma.string('Description'),
  },
  example: ({ active, name, description }) => (
    <OptionRadio active={active} onClick={() => {}} name={name} description={description} />
  ),
});
