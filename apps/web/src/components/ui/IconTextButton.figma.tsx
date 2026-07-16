import figma from '@figma/code-connect';
import IconTextButton from './IconTextButton';

figma.connect(IconTextButton, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=38-3', {
  example: () => <IconTextButton icon={<span />} title="Action" />,
});
