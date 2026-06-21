// skills/source.ts — parse + normalise a community-skill install source into a
// concrete fetch plan, with a strict host allowlist (anti-SSRF).
//
// Two providers:
//   - github   (the open Agent Skills ecosystem is GitHub-backed: skills.sh too)
//   - clawhub  (clawhub.ai / OpenClaw — hosts skill zips behind its own API)
//
// Supported inputs:
//   - https://github.com/<owner>/<repo>[/tree/<ref>/<path>]
//   - <owner>/<repo>[/<path...>]              (shorthand → GitHub, default branch)
//   - skills-sh/<owner>/<repo>/<skill>        (skills.sh registry path)
//   - https://www.skills.sh/<owner>/<repo>/<skill>
//   - https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>/SKILL.md
//   - https://clawhub.ai/<publisher>/<slug>   (ClawHub skill page)
//
// Anything pointing at a non-allowlisted host is rejected (prevents SSRF).

export type SkillProvider = 'github' | 'clawhub';

/** Resolved, validated plan for fetching a skill. */
export interface SkillSource {
  provider: SkillProvider;
  /** Owner / publisher namespace (informational; GitHub uses it to fetch). */
  owner: string;
  /** GitHub repo (empty for clawhub). */
  repo: string;
  /** Branch / tag / sha (GitHub). Null = try the repo's default branches. */
  ref: string | null;
  /** Path within the repo to the skill folder (GitHub), if known. */
  subdir: string | null;
  /** Which skill to pick in a multi-skill GitHub repo (skills.sh disambiguator). */
  skillName: string | null;
  /** ClawHub skill slug (null for GitHub). */
  slug: string | null;
  /** Echoed back for storage as the install origin + reinstall key. */
  raw: string;
}

export class SkillSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillSourceError';
  }
}

const SEGMENT = '[A-Za-z0-9._-]+';
const OWNER_REPO = new RegExp(`^(${SEGMENT})/(${SEGMENT})$`);

/** Hosts we will fetch from. Everything else is rejected. */
const ALLOWED_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'skills.sh',
  'www.skills.sh',
  'clawhub.ai',
  'www.clawhub.ai',
]);

function stripGitSuffix(repo: string): string {
  return repo.endsWith('.git') ? repo.slice(0, -4) : repo;
}

function github(
  s: Pick<SkillSource, 'owner' | 'repo' | 'ref' | 'subdir' | 'skillName' | 'raw'>,
): SkillSource {
  return { provider: 'github', slug: null, ...s };
}

/**
 * Parse a user-supplied source string into a SkillSource. Throws
 * SkillSourceError on anything malformed or off-allowlist.
 */
export function parseSkillSource(input: string): SkillSource {
  const raw = input.trim();
  if (!raw) throw new SkillSourceError('Empty skill source.');

  // skills.sh registry path: "skills-sh/<owner>/<repo>/<skill>"
  if (raw.startsWith('skills-sh/')) {
    const parts = raw.split('/').filter(Boolean);
    if (parts.length < 3) {
      throw new SkillSourceError('skills.sh path must be "skills-sh/<owner>/<repo>/<skill>".');
    }
    return github({
      owner: parts[1]!,
      repo: stripGitSuffix(parts[2]!),
      ref: null,
      subdir: null,
      skillName: parts[3] ?? null,
      raw,
    });
  }

  // Scheme-less host-prefixed input (e.g. "clawhub.ai/pub/slug" or
  // "github.com/owner/repo"): a GitHub owner can't contain a dot, so a dotted
  // first path segment means the user pasted a host without the scheme. Re-parse
  // as a URL (which also re-applies the host allowlist).
  if (!/^https?:\/\//i.test(raw)) {
    const first = raw.split('/')[0] ?? '';
    if (first.includes('.')) return parseSkillSource(`https://${raw}`);
  }

  // URL forms.
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new SkillSourceError(`Not a valid URL: "${raw}".`);
    }
    if (!ALLOWED_HOSTS.has(url.hostname)) {
      throw new SkillSourceError(
        `Host "${url.hostname}" is not allowed. Install skills from GitHub, skills.sh, or clawhub.ai.`,
      );
    }
    const segs = url.pathname.split('/').filter(Boolean);

    if (url.hostname === 'clawhub.ai' || url.hostname === 'www.clawhub.ai') {
      // /<publisher>/<slug>  (the slug is the last segment ClawHub installs by)
      if (segs.length < 2) {
        throw new SkillSourceError('ClawHub URL must be "https://clawhub.ai/<publisher>/<slug>".');
      }
      return {
        provider: 'clawhub',
        owner: segs[0]!,
        repo: '',
        ref: null,
        subdir: null,
        skillName: null,
        slug: segs[segs.length - 1]!,
        raw,
      };
    }

    if (url.hostname === 'raw.githubusercontent.com') {
      // /<owner>/<repo>/<ref>/<path...>/SKILL.md
      if (segs.length < 4) throw new SkillSourceError('Malformed raw GitHub URL.');
      const [owner, repo, ref, ...rest] = segs;
      if (rest[rest.length - 1]?.toLowerCase() === 'skill.md') rest.pop();
      return github({
        owner: owner!,
        repo: stripGitSuffix(repo!),
        ref: ref!,
        subdir: rest.length ? rest.join('/') : null,
        skillName: null,
        raw,
      });
    }

    if (url.hostname === 'skills.sh' || url.hostname === 'www.skills.sh') {
      // /<owner>/<repo>/<skill>
      if (segs.length < 2) throw new SkillSourceError('Malformed skills.sh URL.');
      return github({
        owner: segs[0]!,
        repo: stripGitSuffix(segs[1]!),
        ref: null,
        subdir: null,
        skillName: segs[2] ?? null,
        raw,
      });
    }

    // github.com: /<owner>/<repo>[/tree/<ref>/<path...>]
    if (segs.length < 2) throw new SkillSourceError('Malformed GitHub URL — expected /owner/repo.');
    const owner = segs[0]!;
    const repo = stripGitSuffix(segs[1]!);
    if (segs[2] === 'tree' && segs.length >= 4) {
      return github({
        owner,
        repo,
        ref: segs[3]!,
        subdir: segs.slice(4).join('/') || null,
        skillName: null,
        raw,
      });
    }
    return github({ owner, repo, ref: null, subdir: null, skillName: null, raw });
  }

  // Shorthand: "<owner>/<repo>" or "<owner>/<repo>/<path...>"
  const m = OWNER_REPO.exec(raw);
  if (m) {
    return github({
      owner: m[1]!,
      repo: stripGitSuffix(m[2]!),
      ref: null,
      subdir: null,
      skillName: null,
      raw,
    });
  }
  const segs = raw.split('/').filter(Boolean);
  if (segs.length >= 2 && new RegExp(`^${SEGMENT}$`).test(segs[0]!)) {
    return github({
      owner: segs[0]!,
      repo: stripGitSuffix(segs[1]!),
      ref: null,
      subdir: segs.slice(2).join('/') || null,
      skillName: null,
      raw,
    });
  }

  throw new SkillSourceError(
    `Could not parse "${raw}". Use a GitHub URL, "owner/repo", a skills.sh path, or a clawhub.ai URL.`,
  );
}

/** Candidate GitHub refs to try, in order, when the source did not pin one. */
export function candidateRefs(source: SkillSource): string[] {
  return source.ref ? [source.ref] : ['main', 'master'];
}

/** GitHub codeload tarball URL for a given ref. */
export function tarballUrl(source: SkillSource, ref: string): string {
  return `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${encodeURIComponent(ref)}`;
}

/** ClawHub skill-download URL (returns a zip). */
export function clawhubDownloadUrl(source: SkillSource): string {
  return `https://clawhub.ai/api/v1/download?slug=${encodeURIComponent(source.slug ?? '')}`;
}
