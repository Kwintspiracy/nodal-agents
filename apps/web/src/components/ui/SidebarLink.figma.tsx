import figma from '@figma/code-connect';
import SidebarLink from './SidebarLink';

figma.connect(SidebarLink, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=145-23', {
  example: () => <SidebarLink href="/agents" label="Agents" dot="agent" count={7} isActive />,
});
