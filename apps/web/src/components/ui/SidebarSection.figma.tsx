import figma from '@figma/code-connect';
import SidebarSection from './SidebarSection';

figma.connect(
  SidebarSection,
  'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=206-7',
  {
    props: {
      label: figma.string('Label'),
    },
    example: ({ label }) => <SidebarSection>{label}</SidebarSection>,
  },
);
