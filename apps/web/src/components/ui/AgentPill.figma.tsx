import figma from '@figma/code-connect';
import AgentPill from './AgentPill';

figma.connect(AgentPill, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=96-12', {
  props: {
    name: figma.string('Name'),
    active: figma.enum('State', { Default: false, Hover: false, Active: true }),
  },
  example: ({ name, active }) => <AgentPill name={name} href="#" active={active} />,
});
