import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Callout } from 'fumadocs-ui/components/callout';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import type { MDXComponents } from 'mdx/types';

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
