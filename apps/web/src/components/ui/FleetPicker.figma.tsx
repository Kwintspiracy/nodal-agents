import figma from '@figma/code-connect';
import FleetPicker from './FleetPicker';

figma.connect(FleetPicker, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=60-3', {
  example: () => (
    <FleetPicker
      fleets={[
        { id: 'default', name: 'Default', tag: 'main', color: 'agent', icon: '🛰', count: 3 },
      ]}
      activeId="default"
      onChange={() => {}}
      onNewWorkspace={() => {}}
    />
  ),
});
