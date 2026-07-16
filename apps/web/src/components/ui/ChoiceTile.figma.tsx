import figma from '@figma/code-connect';
import ChoiceTile from './ChoiceTile';

figma.connect(ChoiceTile, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=46-3', {
  example: () => <ChoiceTile icon={<span />} label="Option" onClick={() => {}} />,
});
