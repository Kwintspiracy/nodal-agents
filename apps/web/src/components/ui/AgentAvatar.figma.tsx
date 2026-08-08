import figma from '@figma/code-connect';
import AgentAvatar from './AgentAvatar';

figma.connect(AgentAvatar, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=48-15', {
  props: {
    size: figma.enum('Size', { sm: 'sm', md: 'md', lg: 'lg' }),
    shape: figma.enum('Shape', { round: 'round', square: 'square' }),
  },
  example: ({ size, shape }) => <AgentAvatar name="Ada" size={size} shape={shape} />,
});
