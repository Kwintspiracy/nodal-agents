import figma from '@figma/code-connect';
import PrimaryButton from './PrimaryButton';

figma.connect(PrimaryButton, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=90-50', {
  props: {
    variant: figma.enum('Variant', {
      ink: 'ink',
      agent: 'agent',
      coral: 'coral',
      blue: 'blue',
      neutral: 'neutral',
      danger: 'danger',
    }),
    size: figma.enum('Size', { md: 'md', sm: 'sm' }),
    label: figma.string('Label'),
    // In code the icon is a leading child (e.g. <Plus size={13} weight="bold" />),
    // mirrored in Figma by the `Has Icon` boolean + `Icon` instance swap.
    icon: figma.boolean('Has Icon', {
      true: figma.instance('Icon'),
      false: undefined,
    }),
  },
  example: ({ variant, size, label, icon }) => (
    <PrimaryButton variant={variant} size={size}>
      {icon}
      {label}
    </PrimaryButton>
  ),
});
