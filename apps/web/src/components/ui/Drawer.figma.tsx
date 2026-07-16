import figma from '@figma/code-connect';
import Drawer from './Drawer';

figma.connect(Drawer, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=152-3', {
  props: {},
  example: () => (
    <Drawer open onClose={() => {}}>
      <div>Panel content</div>
    </Drawer>
  ),
});
