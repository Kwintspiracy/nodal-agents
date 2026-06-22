// community-skill-catalog.ts — a CURATED shortlist of community skills (open
// Agent Skills / SKILL.md format) the dashboard offers as one-click installs.
//
// This is NOT the install mechanism — that is installCommunitySkillAction →
// the runner's /api/skills/install, which accepts ANY source (the paste-a-URL
// modal stays for that). This list is the discoverability layer: a small set of
// vetted skills with a known `source`, so a user can install e.g. ComfyUI with
// one click instead of hunting for the repo. `source` is whatever the installer
// accepts (here: an `owner/repo/subpath` GitHub source). `sourceHost` only
// labels the button ("Install from GitHub").

export type CommunitySkillCatalogEntry = {
  /** Stable slug — also used to detect whether it is already installed. */
  slug: string;
  name: string;
  description: string;
  /** The install source string passed to installCommunitySkillAction. */
  source: string;
  /** Where `source` lives — labels the install button (github → "GitHub"). */
  sourceHost: 'github' | 'skills-sh';
  /** Display category (mono-uppercase line on the card). */
  category: string;
};

/**
 * The curated catalog. Order matters — rendered top-to-bottom on the page.
 */
export const COMMUNITY_SKILL_CATALOG: CommunitySkillCatalogEntry[] = [
  {
    slug: 'comfyui',
    name: 'ComfyUI',
    description:
      'Generate images, video and audio with your own ComfyUI (local, Desktop or Cloud) — run any workflow with parameter injection. Requires a running ComfyUI + python3.',
    source: 'NousResearch/hermes-agent/skills/creative/comfyui',
    sourceHost: 'github',
    category: 'Creative',
  },
  {
    slug: 'excel-author',
    name: 'Excel author',
    description:
      'Build auditable Excel workbooks headlessly (openpyxl) — real formulas instead of hardcoded values, cell-colour conventions and balance checks. Needs python3.',
    source: 'NousResearch/hermes-agent/optional-skills/finance/excel-author',
    sourceHost: 'github',
    category: 'Office & documents',
  },
  {
    slug: 'pptx-author',
    name: 'PowerPoint author',
    description:
      'Generate PowerPoint decks headlessly (python-pptx) — slides, speaker notes and templates, with numbers traceable back to a workbook. Needs python3.',
    source: 'NousResearch/hermes-agent/optional-skills/finance/pptx-author',
    sourceHost: 'github',
    category: 'Office & documents',
  },
  {
    slug: 'ocr-and-documents',
    name: 'PDF & OCR',
    description:
      'Extract text from PDFs and scanned images (pymupdf, marker-pdf) — searchable text out of documents that have none. Needs python3.',
    source: 'NousResearch/hermes-agent/skills/productivity/ocr-and-documents',
    sourceHost: 'github',
    category: 'Office & documents',
  },
  {
    slug: 'nano-pdf',
    name: 'PDF editor',
    description:
      'Edit PDF text, fix typos and change titles from natural-language prompts (nano-pdf CLI) — no re-export from the source document.',
    source: 'NousResearch/hermes-agent/skills/productivity/nano-pdf',
    sourceHost: 'github',
    category: 'Office & documents',
  },
  {
    slug: 'youtube-content',
    name: 'YouTube content',
    description:
      'Turn YouTube videos into summaries, threads and blog posts from their transcripts — no video download.',
    source: 'NousResearch/hermes-agent/skills/media/youtube-content',
    sourceHost: 'github',
    category: 'Media',
  },
  {
    slug: 'whisper',
    name: 'Whisper speech-to-text',
    description:
      'Local speech-to-text in 99 languages (OpenAI Whisper) — transcription and translation, offline. Needs python3.',
    source: 'NousResearch/hermes-agent/optional-skills/mlops/whisper',
    sourceHost: 'github',
    category: 'Media',
  },
  {
    slug: 'osint-investigation',
    name: 'OSINT investigation',
    description:
      'Public-records OSINT — SEC EDGAR filings, USAspending contracts, sanctions lists and court records, with entity resolution. No API key (stdlib only).',
    source: 'NousResearch/hermes-agent/optional-skills/research/osint-investigation',
    sourceHost: 'github',
    category: 'Research',
  },
  {
    slug: 'stocks',
    name: 'Stocks & crypto',
    description:
      'Stock quotes, history, comparison and crypto prices via Yahoo Finance. No API key.',
    source: 'NousResearch/hermes-agent/optional-skills/finance/stocks',
    sourceHost: 'github',
    category: 'Finance',
  },

  // ─── Tier S — official orgs / known authors, paths verified 200 (2026-06-22) ──

  // Anthropic (anthropics/skills, Apache-2.0)
  {
    slug: 'doc-coauthoring',
    name: 'Doc co-authoring',
    description: 'Structured workflow to co-author docs, proposals, specs and decision documents.',
    source: 'anthropics/skills/skills/doc-coauthoring',
    sourceHost: 'github',
    category: 'Office & documents',
  },
  {
    slug: 'skill-creator',
    name: 'Skill creator',
    description:
      "Create, evaluate and package new agent skills — Anthropic's official skill scaffolder.",
    source: 'anthropics/skills/skills/skill-creator',
    sourceHost: 'github',
    category: 'Development',
  },
  {
    slug: 'mcp-builder',
    name: 'MCP builder',
    description: 'Guidance for building well-designed MCP servers with good tools.',
    source: 'anthropics/skills/skills/mcp-builder',
    sourceHost: 'github',
    category: 'Development',
  },
  {
    slug: 'webapp-testing',
    name: 'Web app testing',
    description:
      'Test and debug local web apps with Playwright — screenshots, console logs, server lifecycle. Needs python3.',
    source: 'anthropics/skills/skills/webapp-testing',
    sourceHost: 'github',
    category: 'Development',
  },
  {
    slug: 'frontend-design',
    name: 'Frontend design',
    description:
      'Opinionated guidance for distinctive, intentional UI and visual design (one of the most-installed skills).',
    source: 'anthropics/skills/skills/frontend-design',
    sourceHost: 'github',
    category: 'Design',
  },
  {
    slug: 'canvas-design',
    name: 'Canvas design',
    description: 'Design-philosophy-driven visual art as PNG/PDF compositions.',
    source: 'anthropics/skills/skills/canvas-design',
    sourceHost: 'github',
    category: 'Design',
  },
  {
    slug: 'theme-factory',
    name: 'Theme factory',
    description: 'Style artifacts (slides, docs, HTML) with preset or custom themes.',
    source: 'anthropics/skills/skills/theme-factory',
    sourceHost: 'github',
    category: 'Design',
  },
  {
    slug: 'algorithmic-art',
    name: 'Algorithmic art',
    description: 'Generative art via p5.js (flow fields, particles) as self-contained HTML.',
    source: 'anthropics/skills/skills/algorithmic-art',
    sourceHost: 'github',
    category: 'Media',
  },
  {
    slug: 'internal-comms',
    name: 'Internal comms',
    description: 'Write internal company communications in preferred formats.',
    source: 'anthropics/skills/skills/internal-comms',
    sourceHost: 'github',
    category: 'Productivity',
  },

  // Superpowers (obra/superpowers, MIT) — dev methodology
  {
    slug: 'test-driven-development',
    name: 'Test-driven development',
    description: 'Enforce RED-GREEN-REFACTOR — write tests before code (Superpowers).',
    source: 'obra/superpowers/skills/test-driven-development',
    sourceHost: 'github',
    category: 'Development',
  },
  {
    slug: 'systematic-debugging',
    name: 'Systematic debugging',
    description: 'Hypothesis-first structured debugging — understand before fixing (Superpowers).',
    source: 'obra/superpowers/skills/systematic-debugging',
    sourceHost: 'github',
    category: 'Development',
  },
  {
    slug: 'writing-plans',
    name: 'Writing plans',
    description: 'Turn a spec into an actionable, checkpointed implementation plan (Superpowers).',
    source: 'obra/superpowers/skills/writing-plans',
    sourceHost: 'github',
    category: 'Development',
  },
  {
    slug: 'verification-before-completion',
    name: 'Verify before done',
    description: 'Show real evidence before claiming a task is complete (Superpowers).',
    source: 'obra/superpowers/skills/verification-before-completion',
    sourceHost: 'github',
    category: 'Development',
  },
  {
    slug: 'using-git-worktrees',
    name: 'Git worktrees',
    description: 'Isolated parallel workspaces with git worktrees (Superpowers).',
    source: 'obra/superpowers/skills/using-git-worktrees',
    sourceHost: 'github',
    category: 'Development',
  },

  // Vendor-official
  {
    slug: 'find-skills',
    name: 'Find skills',
    description: 'Discover and install agent skills on demand (Vercel) — the most-installed skill.',
    source: 'vercel-labs/skills/skills/find-skills',
    sourceHost: 'github',
    category: 'Development',
  },
  {
    slug: 'agent-browser',
    name: 'Agent browser',
    description: 'Drive a real browser for agent tasks (Vercel). Needs the browser runtime.',
    source: 'vercel-labs/agent-browser/skills/agent-browser',
    sourceHost: 'github',
    category: 'Web',
  },
  {
    slug: 'react-best-practices',
    name: 'React best practices',
    description: 'React patterns and performance guidance (Vercel).',
    source: 'vercel-labs/agent-skills/skills/react-best-practices',
    sourceHost: 'github',
    category: 'Development',
  },
  {
    slug: 'web-design-guidelines',
    name: 'Web design guidelines',
    description: 'Practical web design heuristics and guidelines (Vercel).',
    source: 'vercel-labs/agent-skills/skills/web-design-guidelines',
    sourceHost: 'github',
    category: 'Design',
  },
  {
    slug: 'playwright',
    name: 'Playwright browser',
    description:
      'Browser automation — navigate, fill forms, scrape (OpenAI). Needs the Playwright runtime.',
    source: 'openai/skills/skills/.curated/playwright',
    sourceHost: 'github',
    category: 'Web',
  },
  {
    slug: 'supabase-postgres-best-practices',
    name: 'Supabase / Postgres',
    description: 'Postgres & Supabase schema, RLS and query best practices (Supabase).',
    source: 'supabase/agent-skills/skills/supabase-postgres-best-practices',
    sourceHost: 'github',
    category: 'Development',
  },
  {
    slug: 'workers-best-practices',
    name: 'Cloudflare Workers',
    description: 'Author and review Cloudflare Workers code (Cloudflare).',
    source: 'cloudflare/skills/skills/workers-best-practices',
    sourceHost: 'github',
    category: 'Development',
  },
  {
    slug: 'firecrawl-scrape',
    name: 'Firecrawl scrape',
    description: 'Scrape any page to clean markdown via Firecrawl. Needs a Firecrawl API key.',
    source: 'firecrawl/firecrawl-claude-plugin/skills/firecrawl-scrape',
    sourceHost: 'github',
    category: 'Web',
  },
  {
    slug: 'firecrawl-search',
    name: 'Firecrawl search',
    description: 'Web search via Firecrawl. Needs a Firecrawl API key.',
    source: 'firecrawl/firecrawl-claude-plugin/skills/firecrawl-search',
    sourceHost: 'github',
    category: 'Web',
  },
  {
    slug: 'semgrep',
    name: 'Semgrep static analysis',
    description: 'Find security bugs with Semgrep static analysis (Trail of Bits). Needs python3.',
    source: 'trailofbits/skills/plugins/static-analysis/skills/semgrep',
    sourceHost: 'github',
    category: 'Security',
  },
  {
    slug: 'codeql',
    name: 'CodeQL static analysis',
    description: 'CodeQL static analysis for security review (Trail of Bits).',
    source: 'trailofbits/skills/plugins/static-analysis/skills/codeql',
    sourceHost: 'github',
    category: 'Security',
  },

  // Finance models (Anthropic-adapted, pairs with Excel author)
  {
    slug: 'dcf-model',
    name: 'DCF model',
    description: 'Build institutional-quality DCF valuation models in Excel. Needs python3.',
    source: 'NousResearch/hermes-agent/optional-skills/finance/dcf-model',
    sourceHost: 'github',
    category: 'Finance',
  },
  {
    slug: '3-statement-model',
    name: '3-statement model',
    description: 'Build fully-integrated 3-statement models (income, balance, cash flow) in Excel.',
    source: 'NousResearch/hermes-agent/optional-skills/finance/3-statement-model',
    sourceHost: 'github',
    category: 'Finance',
  },
  {
    slug: 'lbo-model',
    name: 'LBO model',
    description: 'Leveraged-buyout models — sources & uses, debt schedule, IRR/MOIC, in Excel.',
    source: 'NousResearch/hermes-agent/optional-skills/finance/lbo-model',
    sourceHost: 'github',
    category: 'Finance',
  },
  {
    slug: 'comps-analysis',
    name: 'Comps analysis',
    description: 'Comparable-company analysis — trading multiples and benchmarking, in Excel.',
    source: 'NousResearch/hermes-agent/optional-skills/finance/comps-analysis',
    sourceHost: 'github',
    category: 'Finance',
  },
  {
    slug: 'merger-model',
    name: 'Merger model',
    description: 'Accretion/dilution merger models — pro-forma P&L and EPS impact, in Excel.',
    source: 'NousResearch/hermes-agent/optional-skills/finance/merger-model',
    sourceHost: 'github',
    category: 'Finance',
  },

  // Media
  {
    slug: 'remotion',
    name: 'Remotion video',
    description: 'Programmatic video with React via Remotion (official). Needs node.',
    source: 'remotion-dev/skills/skills/remotion',
    sourceHost: 'github',
    category: 'Media',
  },
];
