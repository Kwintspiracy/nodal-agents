import figma from '@figma/code-connect';
import Tabs from './Tabs';

figma.connect(Tabs, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=85-67', {
  example: () => (
    <Tabs
      tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'settings', label: 'Settings' },
      ]}
      value="settings"
      onChange={() => {}}
    />
  ),
});
