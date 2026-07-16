import figma from '@figma/code-connect';
import Switch from './Switch';

figma.connect(Switch, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=108-18', {
  props: {
    size: figma.enum('Size', { sm: 'sm', md: 'md' }),
  },
  example: ({ size }) => (
    <Switch
      checked
      onChange={() => {}}
      size={size}
      ariaLabel="Toggle"
      trackClassName="bg-agent-vivid"
      thumbClassName="bg-paper"
    />
  ),
});
