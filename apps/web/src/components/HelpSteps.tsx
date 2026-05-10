'use client';

import type { Guide } from '@/lib/connector-help.ts';

interface Props {
  guide: Guide;
}

export default function HelpSteps({ guide }: Props) {
  return (
    <div className="space-y-3">
      {guide.intro && <p className="text-xs text-neutral-500 italic">{guide.intro}</p>}

      <ol className="space-y-2.5">
        {guide.steps.map((step) => (
          <li key={step.number} className="flex gap-2">
            {/* Numbered circle */}
            <span className="shrink-0 w-5 h-5 rounded-full bg-neutral-800 text-neutral-500 text-[10px] font-bold flex items-center justify-center mt-0.5">
              {step.number}
            </span>

            <div className="space-y-1.5 text-sm text-neutral-400">
              {/* Step text + optional inline link */}
              <span>
                {step.text}
                {step.link && (
                  <>
                    {' '}
                    <a
                      href={step.link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-400 hover:text-indigo-300 underline"
                    >
                      {step.link.label}
                    </a>
                  </>
                )}
              </span>

              {/* Sub-links rendered as a bullet list (e.g. Google API enables) */}
              {step.subLinks && step.subLinks.length > 0 && (
                <ul className="mt-1 space-y-1 pl-1">
                  {step.subLinks.map((sl) => (
                    <li key={sl.href} className="flex items-center gap-1.5 text-xs">
                      <span className="text-neutral-600">•</span>
                      <a
                        href={sl.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-400 hover:text-indigo-300 underline"
                      >
                        {sl.label}
                      </a>
                    </li>
                  ))}
                </ul>
              )}

              {/* Hint / sub-note */}
              {step.hint && <p className="text-xs text-neutral-500 italic">{step.hint}</p>}
            </div>
          </li>
        ))}
      </ol>

      {/* Format reminder */}
      {guide.format && (
        <p className="text-xs text-neutral-500">
          Format: <code className="font-mono text-neutral-400">{guide.format}</code>
        </p>
      )}
    </div>
  );
}
