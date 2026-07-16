import figma from '@figma/code-connect';
import EmojiPicker from './EmojiPicker';

figma.connect(EmojiPicker, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=63-2', {
  example: () => <EmojiPicker value="🤖" onChange={() => {}} />,
});
