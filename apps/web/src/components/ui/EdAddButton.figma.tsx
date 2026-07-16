import figma from '@figma/code-connect';
import EdAddButton from './EdAddButton';

figma.connect(EdAddButton, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=102-17', {
  props: {
    size: figma.enum('Size', { md: 'md', sm: 'sm', lg: 'lg' }),
  },
  example: ({ size }) => (
    <EdAddButton size={size} onClick={() => {}}>
      Add
    </EdAddButton>
  ),
});
