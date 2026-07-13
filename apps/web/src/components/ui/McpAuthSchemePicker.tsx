'use client';

type Scheme = 'header' | 'query' | 'bearer';

const LABELS: Record<Scheme, string> = {
  header: 'Header',
  query: 'Query param',
  bearer: 'Bearer',
};

type Props = {
  name: string;
  value: Scheme;
  onChange: (scheme: Scheme) => void;
};

/**
 * McpAuthSchemePicker — pill-style radio group for the MCP custom-HTTP auth
 * scheme choice (header / query param / bearer), shared verbatim by
 * McpAddForm and McpEditForm. Domain-specific to MCP forms — not a general
 * SegmentedControl; reconcile with any transverse component P2A promotes.
 */
export default function McpAuthSchemePicker({ name, value, onChange }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      {(['header', 'query', 'bearer'] as const).map((scheme) => (
        <label
          key={scheme}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs cursor-pointer border ${
            value === scheme
              ? 'bg-hover border-ink-3 text-ink'
              : 'bg-paper border-rule text-ink-3 hover:border-rule'
          }`}
        >
          <input
            type="radio"
            name={name}
            value={scheme}
            checked={value === scheme}
            onChange={() => onChange(scheme)}
            className="sr-only"
          />
          {LABELS[scheme]}
        </label>
      ))}
    </div>
  );
}
