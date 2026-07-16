import figma from '@figma/code-connect';
import { SetRow } from './SetRow';

figma.connect(SetRow, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=206-2', {
  props: {
    label: figma.string('Label'),
    sub: figma.boolean('Has sub', {
      true: figma.string('Sub'),
      false: undefined,
    }),
    value: figma.string('Value'),
  },
  example: ({ label, sub, value }) => (
    <SetRow label={label} sub={sub}>
      {value}
    </SetRow>
  ),
});
