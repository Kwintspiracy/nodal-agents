import figma from '@figma/code-connect';
import DisclosureButton from './DisclosureButton';

figma.connect(
  DisclosureButton,
  'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=102-8',
  {
    example: () => (
      <DisclosureButton open onClick={() => {}}>
        Details
      </DisclosureButton>
    ),
  },
);
