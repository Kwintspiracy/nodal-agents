import figma from '@figma/code-connect';
import LiveDot from './LiveDot';

figma.connect(LiveDot, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=31-37', {
  props: {
    variant: figma.enum('Variant', {
      ok: 'ok',
      lime: 'lime',
      coral: 'coral',
      blue: 'blue',
      warn: 'warn',
    }),
    size: figma.enum('Size', { sm: 'sm', md: 'md' }),
  },
  example: ({ variant, size }) => <LiveDot variant={variant} size={size} />,
});
