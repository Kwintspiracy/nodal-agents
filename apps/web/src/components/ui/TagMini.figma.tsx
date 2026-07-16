import figma from '@figma/code-connect';
import { TagMini } from './TagMini';

figma.connect(TagMini, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=30-7', {
  props: {
    variant: figma.enum('Variant', { ok: 'ok', warn: 'warn' }),
  },
  example: ({ variant }) => <TagMini variant={variant}>OK</TagMini>,
});
