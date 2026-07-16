import figma from '@figma/code-connect';
import IconButton from './IconButton';

figma.connect(IconButton, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=118-36', {
  example: () => (
    <IconButton aria-label="Action">
      <span />
    </IconButton>
  ),
});
