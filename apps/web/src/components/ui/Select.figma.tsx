import figma from '@figma/code-connect';
import Select from './Select';

figma.connect(Select, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=27-19', {
  example: () => (
    <Select>
      <option>Option</option>
    </Select>
  ),
});
