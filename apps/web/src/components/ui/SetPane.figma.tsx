import figma from '@figma/code-connect';
import { SetPane } from './SetPane';

figma.connect(SetPane, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=149-3', {
  example: () => (
    <SetPane>
      <div />
    </SetPane>
  ),
});
