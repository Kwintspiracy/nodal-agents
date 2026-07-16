import figma from '@figma/code-connect';
import { SetBlock } from './SetBlock';

figma.connect(SetBlock, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=149-35', {
  example: () => (
    <SetBlock label="CAPABILITIES" lede="What this agent may do.">
      <span />
    </SetBlock>
  ),
});
