import figma from '@figma/code-connect';
import StarRating from './StarRating';

figma.connect(StarRating, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=44-40', {
  props: {
    size: figma.enum('Size', { md: 'md', sm: 'sm' }),
  },
  example: ({ size }) => <StarRating value={4} onChange={() => {}} size={size} />,
});
