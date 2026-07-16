import figma from '@figma/code-connect';
import SegmentedControl from './SegmentedControl';

figma.connect(
  SegmentedControl,
  'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=105-16',
  {
    example: () => (
      <SegmentedControl
        options={[
          { value: 'all', label: 'All' },
          { value: 'mine', label: 'Mine' },
        ]}
        value="all"
        onChange={() => {}}
      />
    ),
  },
);
