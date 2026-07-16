import figma from '@figma/code-connect';
import Banner from './Banner';

figma.connect(Banner, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=49-21', {
  props: {
    variant: figma.enum('Variant', { info: 'info', warn: 'warn', tip: 'tip' }),
  },
  example: ({ variant }) => <Banner variant={variant}>Message</Banner>,
});
