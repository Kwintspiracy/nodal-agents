import figma from '@figma/code-connect';
import { SetUrl } from './SetUrl';

figma.connect(SetUrl, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=149-24', {
  example: () => <SetUrl subtitle="Webhook URL" url="https://nodal.app/hooks/ag_8fk2" />,
});
