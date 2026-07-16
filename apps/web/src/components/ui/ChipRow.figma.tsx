import figma from '@figma/code-connect';
import ChipRow from './ChipRow';

figma.connect(ChipRow, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=53-3', {
  example: () => (
    <ChipRow
      items={[
        { value: 'a', label: 'All' },
        { value: 'b', label: 'Mine' },
      ]}
      value="a"
      onChange={() => {}}
    />
  ),
});
