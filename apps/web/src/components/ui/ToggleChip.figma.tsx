import figma from '@figma/code-connect';
import ToggleChip from './ToggleChip';

figma.connect(ToggleChip, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=105-23', {
  example: () => (
    <ToggleChip active onClick={() => {}}>
      Filter
    </ToggleChip>
  ),
});
