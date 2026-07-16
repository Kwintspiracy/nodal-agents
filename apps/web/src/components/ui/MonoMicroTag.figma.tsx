import figma from '@figma/code-connect';
import { MonoMicroTag } from './MonoMicroTag';

figma.connect(MonoMicroTag, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=144-9', {
  props: {
    tone: figma.enum('Tone', { err: 'err', skill: 'skill', warn: 'warn' }),
  },
  example: ({ tone }) => <MonoMicroTag tone={tone}>irreversible</MonoMicroTag>,
});
