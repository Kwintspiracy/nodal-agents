import figma from '@figma/code-connect';
import SelectableTile from './SelectableTile';

figma.connect(SelectableTile, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=46-11', {
  props: {
    selected: figma.enum('State', { Default: false, Selected: true }),
  },
  example: ({ selected }) => (
    <SelectableTile selected={selected} onClick={() => {}} label="Pick">
      <span />
    </SelectableTile>
  ),
});
