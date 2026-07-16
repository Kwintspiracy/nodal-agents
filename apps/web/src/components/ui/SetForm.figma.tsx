import figma from '@figma/code-connect';
import { SetForm } from './SetForm';

figma.connect(SetForm, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=149-13', {
  example: () => (
    <SetForm label="When an agent learns a new skill">
      <span />
    </SetForm>
  ),
});
