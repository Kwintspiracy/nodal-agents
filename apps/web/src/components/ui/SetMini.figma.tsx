import figma from '@figma/code-connect';
import { SetMini } from './SetMini';

figma.connect(SetMini, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=149-18', {
  example: () => (
    <SetMini name="Google OAuth" description="Connect a Google account." action={<span />} />
  ),
});
