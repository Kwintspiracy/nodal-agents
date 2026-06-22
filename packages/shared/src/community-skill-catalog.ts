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
];
