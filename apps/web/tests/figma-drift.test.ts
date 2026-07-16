// figma-drift.test.ts — the drift detector must actually DETECT drift, not
// just pass on today's clean state. Fixtures simulate each divergence class
// against the pure functions (no network, no Figma token).
import { describe, expect, it } from 'vitest';
import {
  parseFigmaTsx,
  extractFigmaComponents,
  computeDrift,
} from '../scripts/check-figma-drift.mjs';

const BUTTON_FIGMA_TSX = `
import figma from '@figma/code-connect';
import PrimaryButton from './PrimaryButton';
figma.connect(PrimaryButton, 'https://www.figma.com/design/KEY?node-id=90-50', {
  props: {
    variant: figma.enum('Variant', {
      ink: 'ink',
      agent: 'agent',
    }),
    size: figma.enum('Size', { md: 'md', sm: 'sm' }),
    label: figma.string('Label'),
    icon: figma.boolean('Has Icon', { true: figma.instance('Icon'), false: undefined }),
  },
});
`;

function figmaFile(buttonVariants: string[]) {
  return {
    document: {
      children: [
        {
          name: 'Button',
          type: 'CANVAS',
          children: [
            {
              id: '90:50',
              name: 'Button',
              type: 'COMPONENT_SET',
              children: buttonVariants.map((name, i) => ({
                id: `90:${100 + i}`,
                name,
                type: 'COMPONENT',
              })),
            },
          ],
        },
        {
          name: 'Icons',
          type: 'CANVAS',
          children: [{ id: '109:4', name: 'Icon/Archive', type: 'COMPONENT' }],
        },
      ],
    },
  };
}

const CLEAN_VARIANTS = [
  'Variant=ink, Size=md, State=Default',
  'Variant=ink, Size=sm, State=Default',
  'Variant=agent, Size=md, State=Default',
  'Variant=agent, Size=sm, State=Default',
];

function run(overrides: {
  variants?: string[];
  parsedFiles?: { file: string; parsed: ReturnType<typeof parseFigmaTsx> }[];
  uiComponentNames?: string[];
}) {
  const figmaComponents = extractFigmaComponents(figmaFile(overrides.variants ?? CLEAN_VARIANTS));
  return computeDrift({
    figmaComponents,
    parsedFiles: overrides.parsedFiles ?? [
      { file: 'PrimaryButton.figma.tsx', parsed: parseFigmaTsx(BUTTON_FIGMA_TSX) },
    ],
    uiComponentNames: overrides.uiComponentNames ?? ['PrimaryButton'],
  });
}

describe('parseFigmaTsx', () => {
  it('extracts node id, enums, string, boolean and instance props', () => {
    const parsed = parseFigmaTsx(BUTTON_FIGMA_TSX);
    expect(parsed.mappings).toEqual([{ componentName: 'PrimaryButton', nodeId: '90:50' }]);
    expect(parsed.enums['Variant']).toEqual(['ink', 'agent']);
    expect(parsed.enums['Size']).toEqual(['md', 'sm']);
    expect(parsed.strings).toContain('Label');
    expect(parsed.booleans).toContain('Has Icon');
    expect(parsed.instances).toContain('Icon');
  });
});

describe('extractFigmaComponents', () => {
  it('derives variant axes from child names and lists standalone components', () => {
    const comps = extractFigmaComponents(figmaFile(CLEAN_VARIANTS));
    const button = comps.find((c) => c.nodeId === '90:50');
    expect([...(button?.axes?.['Variant'] ?? [])].sort()).toEqual(['agent', 'ink']);
    expect([...(button?.axes?.['State'] ?? [])]).toEqual(['Default']);
    const icon = comps.find((c) => c.name === 'Icon/Archive');
    expect(icon?.axes).toBeNull();
  });
});

describe('computeDrift', () => {
  it('passes clean on a synchronized mirror (State axis allowlisted)', () => {
    const { errors, warnings } = run({});
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('E4: detects a variant value added in Figma but absent from the mapping', () => {
    const { errors } = run({
      variants: [...CLEAN_VARIANTS, 'Variant=ghost, Size=md, State=Default'],
    });
    expect(errors.some((e) => e.includes('Variant=ghost') && e.startsWith('E4'))).toBe(true);
  });

  it('E4: detects a mapping value that disappeared from Figma', () => {
    const { errors } = run({
      variants: CLEAN_VARIANTS.filter((v) => !v.includes('agent')),
    });
    expect(errors.some((e) => e.includes('Variant=agent') && e.includes('disparu'))).toBe(true);
  });

  it('E2: detects a stale mapping pointing at a node gone from Figma', () => {
    const stale = parseFigmaTsx(BUTTON_FIGMA_TSX.replace('90-50', '99-99'));
    const { errors } = run({
      parsedFiles: [{ file: 'PrimaryButton.figma.tsx', parsed: stale }],
    });
    expect(errors.some((e) => e.startsWith('E2') && e.includes('99:99'))).toBe(true);
    // ... and the now-unmapped Figma set is also reported (E3).
    expect(errors.some((e) => e.startsWith('E3') && e.includes('"Button"'))).toBe(true);
  });

  it('E1: detects a ui component with no mapping file', () => {
    const { errors } = run({ uiComponentNames: ['PrimaryButton', 'BrandNewThing'] });
    expect(errors.some((e) => e.startsWith('E1') && e.includes('BrandNewThing'))).toBe(true);
  });

  it('external prefixes (icons) are not reported as unmapped', () => {
    const { errors } = run({});
    expect(errors.some((e) => e.includes('Icon/Archive'))).toBe(false);
  });
});
