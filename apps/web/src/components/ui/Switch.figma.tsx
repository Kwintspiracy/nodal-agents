import figma from '@figma/code-connect';
import Switch from './Switch';

// `State` ne devient pas une prop : Off / On sont `checked`, Disabled est
// `disabled`, et Focus est un état du navigateur, pas de React (issue #236).
figma.connect(Switch, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=108-18', {
  props: {
    size: figma.enum('Size', { sm: 'sm', md: 'md' }),
    checked: figma.enum('State', { Off: false, On: true, Focus: true, Disabled: true }),
    disabled: figma.enum('State', { Off: false, On: false, Focus: false, Disabled: true }),
  },
  example: ({ size, checked, disabled }) => (
    <Switch
      checked={checked}
      disabled={disabled}
      onChange={() => {}}
      size={size}
      ariaLabel="Toggle"
    />
  ),
});
