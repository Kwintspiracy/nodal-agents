import figma from '@figma/code-connect';
import StatusPill from './StatusPill';

figma.connect(StatusPill, 'https://www.figma.com/design/GWXBALe90DMFR3XYGccofJ?node-id=29-24', {
  props: {
    variant: figma.enum('Variant', {
      done: 'done',
      warn: 'warn',
      run: 'run',
      idle: 'idle',
      'lvl-info': 'lvl-info',
      'lvl-ok': 'lvl-ok',
      'lvl-warn': 'lvl-warn',
      'lvl-err': 'lvl-err',
    }),
    label: figma.string('Label'),
  },
  example: ({ variant, label }) => <StatusPill variant={variant} label={label} />,
});
