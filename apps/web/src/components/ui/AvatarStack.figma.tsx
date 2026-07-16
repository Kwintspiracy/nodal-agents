import figma from '@figma/code-connect';
import AvatarStack from './AvatarStack';

figma.connect(AvatarStack, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=53-10', {
  example: () => (
    <AvatarStack
      avatars={[
        { id: 'a', name: 'Alfred' },
        { id: 'b', name: 'Java' },
      ]}
    />
  ),
});
