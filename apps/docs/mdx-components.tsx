import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Callout as FumadocsCallout } from 'fumadocs-ui/components/callout';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import type { ComponentProps } from 'react';
import type { MDXComponents } from 'mdx/types';

/**
 * Callout with a per-type class (`nd-callout-<type>`) so global.css can give
 * each type its own soft tinted background. The coloured left bar + icon still
 * come from Fumadocs.
 */
function Callout({ className, type = 'info', ...props }: ComponentProps<typeof FumadocsCallout>) {
  return (
    <FumadocsCallout
      type={type}
      className={['nd-callout', `nd-callout-${type}`, className].filter(Boolean).join(' ')}
      {...props}
    />
  );
}

/**
 * Components available to every MDX/MD page without an explicit import.
 * defaultMdxComponents brings Fumadocs' styled pre/code (copy button, titles),
 * headings, tables, etc.; we add the rich layout components on top.
 */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Callout,
    Card,
    Cards,
    Tab,
    Tabs,
    Step,
    Steps,
    ...components,
  };
}
