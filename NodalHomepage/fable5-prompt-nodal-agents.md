# Fable 5 — Prompt : landing page Nodal-Agents

> Remplace les 5 valeurs `[À REMPLIR]` ci-dessous, puis colle tout le bloc dans Fable 5.

---

## VARIABLES À REMPLIR (avant de coller)

- `[TAGLINE]` = une phrase de positionnement (ex. "The open-source harness for building production-grade AI agents")
- `[FEATURES]` = 3 à 5 fonctionnalités clés, une ligne chacune
- `[NPM]` = nom du package npm (ex. `nodal-agents`)
- `[GITHUB_URL]` = URL du repo GitHub
- `[DOCS_URL]` = URL de la documentation

---

## PROMPT

You are a senior product designer + front-end engineer. Build a single, production-quality landing page for **Nodal-Agents**, a **free, open-source agentic harness** for developers. Goal: make people *want to install it* — not sell it. This is not a pricing page.

**Positioning:** `[TAGLINE]`
**Key features to showcase:** `[FEATURES]`

### Art direction — "warm technical" (this is the core constraint)
Fuse two worlds: the credibility of a serious developer tool (Linear / Vercel / Railway) with the warmth of a premium open-source project (Anthropic-like). Avoid generic SaaS and AI-slop at all costs — no purple-to-blue gradients, no glassmorphism, no floating 3D blobs, no stock-y hero illustrations, no emoji soup.

- **Palette:** warm off-white / cream base (`#FAF7F2`-ish), deep warm charcoal for contrast sections (not pure black), ONE confident warm accent (terracotta / amber / rust). Restrained.
- **Type:** a refined grotesk/humanist sans for headlines + a real monospace for code, labels, eyebrows and metadata. Big, confident type scale.
- **Nodal motif:** subtle nod to the name — thin connecting lines / small nodes linking sections or feature cards. Tasteful, structural, never decorative clutter.
- **Texture:** hairline borders, visible baseline grid, real terminal/code-block components, generous whitespace. Rounded corners but tight, not bubbly.
- **Motion:** minimal and purposeful — quiet fade/slide on scroll, a live-typing terminal, subtle node-line draw. No parallax carnival.

### Sections (top to bottom)
1. **Sticky nav** — wordmark, links to Docs / GitHub, and a primary "Install" CTA. Show the GitHub star count style element.
2. **Hero** — sharp headline from the tagline, one-line subhead, two CTAs ("Get started" → docs, "Star on GitHub"), and a **copy-to-clipboard install command** (`npm i [NPM]`) styled as a real terminal.
3. **Feature grid** — the key features as clean cards connected by the nodal-line motif; each with a mono label, a short benefit line, and a tiny code/diagram detail.
4. **How it works** — 3 steps (install → configure → run) with real code snippets in a terminal/editor component.
5. **Why Nodal-Agents** — short trust section: open-source, free, framework-agnostic, production-ready (adapt to actual features).
6. **Quickstart / install** — prominent `npm i [NPM]`, plus links to Docs and GitHub, and a minimal working code example.
7. **Footer** — links: npm (`https://www.npmjs.com/package/[NPM]`), GitHub (`[GITHUB_URL]`), Docs (`[DOCS_URL]`), license (MIT-style), and a "free & open-source" note.

### Required links (must all be present and working)
- npm package: `https://www.npmjs.com/package/[NPM]`
- GitHub repo: `[GITHUB_URL]`
- Documentation: `[DOCS_URL]`
- Install command copy button: `npm i [NPM]`

### Build requirements
- **Mobile-first**, fully responsive up to desktop. Verify it looks intentional at 375px, 768px and 1440px.
- Semantic HTML, WCAG AA contrast, keyboard-focusable interactive elements, `prefers-reduced-motion` respected.
- Fast: no heavy libraries. Self-contained. Clean, well-commented code.
- Copy is crisp and technical — write for developers, no marketing fluff, no exclamation marks.

Deliver a polished, cohesive page that feels handcrafted by a design-led dev-tools team.
