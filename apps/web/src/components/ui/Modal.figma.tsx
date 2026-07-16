import figma from '@figma/code-connect';
import Modal from './Modal';

figma.connect(Modal, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=55-3', {
  example: () => (
    <Modal open onClose={() => {}} title="Title">
      <div>Body</div>
    </Modal>
  ),
});
