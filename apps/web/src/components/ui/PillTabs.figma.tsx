import figma from '@figma/code-connect';
import PillTabs from './PillTabs';

figma.connect(PillTabs, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=103-30', {
  props: {
    variant: figma.enum('Variant', { inset: 'inset', 'dark-active': 'dark-active' }),
  },
  example: ({ variant }) => (
    <PillTabs
      variant={variant}
      tabs={[
        { value: 'a', label: 'Overview' },
        { value: 'b', label: 'Settings' },
      ]}
      value="a"
      onChange={() => {}}
    />
  ),
});
