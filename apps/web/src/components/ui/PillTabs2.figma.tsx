import figma from '@figma/code-connect';
import PillTabs2 from './PillTabs2';

figma.connect(PillTabs2, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=104-16', {
  example: () => (
    <PillTabs2
      tabs={[
        { value: 'a', label: 'Overview' },
        { value: 'b', label: 'Settings' },
      ]}
      value="a"
      onChange={() => {}}
    />
  ),
});
