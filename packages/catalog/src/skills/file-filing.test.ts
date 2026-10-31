// file-filing.test.ts — the skill carries a METHOD and no folder (invariants #1, #6).
//
// The folders are the owner's: each install writes its own tree in the "Your
// folders" section. These tests hold the two promises that make that safe: the
// shipped text names no real place, and the section the owner fills in is
// there and empty.

import { describe, it, expect } from 'vitest';
import { systemSkills, systemSkillSlugs } from '../index';
import {
  fileFilingSkill,
  FILE_FILING_FOLDERS_HEADING,
  FILE_FILING_PLACEHOLDER,
} from './file-filing';

/** The body of "Your folders": everything after its heading, up to the next heading. */
function foldersSection(content: string): string {
  const at = content.indexOf(FILE_FILING_FOLDERS_HEADING);
  if (at < 0) throw new Error('the "Your folders" section is gone');
  const rest = content.slice(at + FILE_FILING_FOLDERS_HEADING.length);
  const next = rest.search(/\n#{1,6} /);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * What a person (or the model) would call "written" in that section: everything
 * but the placeholder line. A line the owner wrote counts wherever it sits.
 */
function writtenFolders(section: string): string {
  return section.replace(FILE_FILING_PLACEHOLDER, '').trim();
}

// A drive letter (`C:\`, `D:/`), a UNC share, a home folder, or a POSIX absolute
// path under a directory that only exists on a real machine.
const ABSOLUTE_PATH =
  /\b[A-Za-z]:[\\/]|\\\\[A-Za-z0-9_.-]+\\|(?:^|[\s"'`(])~[\\/]|(?:^|[\s"'`(])\/(?:Users|home|mnt|var|etc|opt|root)\//m;

// No @cap tag on purpose: this proves the shipped TEXT, not that an agent files
// well. A /moteur label would paint green a behaviour nobody measured.
describe('file-filing skill', () => {
  it('is in the catalog under the slug the dashboard and the seeder use', () => {
    expect(systemSkills).toContain(fileFilingSkill);
    expect(systemSkillSlugs).toContain('file-filing');
    expect(fileFilingSkill.name).toBe('File filing');
  });

  it('is guidance, never a switch: it unlocks no tool', () => {
    expect(fileFilingSkill.requiredBuiltins).toEqual([]);
  });

  it('says in its one-line description when to load it', () => {
    const d = fileFilingSkill.description.toLowerCase();
    for (const trigger of ['file', 'sort', 'tidy', 'rename', 'put away', 'scan', 'download']) {
      expect(d, `the description no longer says "${trigger}"`).toContain(trigger);
    }
    expect(fileFilingSkill.description).not.toContain('\n');
  });

  it('carries no absolute path, drive letter, home folder or user name', () => {
    const text = `${fileFilingSkill.description}\n${fileFilingSkill.content}`;
    expect(text).not.toMatch(ABSOLUTE_PATH);
    expect(text).not.toMatch(/quentin/i);
  });

  it('ends with a "Your folders" section that is present and empty', () => {
    const c = fileFilingSkill.content;
    expect(c.split(FILE_FILING_FOLDERS_HEADING), 'the heading must appear once').toHaveLength(2);
    expect(
      c.slice(c.indexOf(FILE_FILING_FOLDERS_HEADING) + FILE_FILING_FOLDERS_HEADING.length),
      'a section follows "Your folders": the owner would write inside the wrong one',
    ).not.toMatch(/\n#{1,6} /);
    const section = foldersSection(c);
    expect(section, 'the section no longer tells the owner what to write').toContain(
      FILE_FILING_PLACEHOLDER,
    );
    expect(writtenFolders(section), 'a folder is shipped in the catalog').toBe('');
  });

  // P2-2 (review of #895): the placeholder was an HTML comment, and the owner
  // was invited to write INSIDE it, where the method counts it as empty. A
  // visible line has no inside: the owner replaces it, the model reads the same
  // text. No comment may come back anywhere in the skill.
  it('the placeholder is a visible line, never an HTML comment the owner could write inside', () => {
    const c = fileFilingSkill.content;
    expect(c).not.toContain('<!--');
    expect(c).not.toContain('-->');
    expect(FILE_FILING_PLACEHOLDER).not.toContain('\n');
    expect(FILE_FILING_PLACEHOLDER).toMatch(/^\(Not filled in yet\./);
    expect(FILE_FILING_PLACEHOLDER, 'it must tell the owner to REPLACE the line').toMatch(
      /Replace this line/,
    );
    // The example inside the placeholder is relative and generic.
    expect(FILE_FILING_PLACEHOLDER).not.toMatch(ABSOLUTE_PATH);
  });

  it('the method defines the empty case by that very line, and says its example is not a folder', () => {
    const c = fileFilingSkill.content;
    expect(c).toContain('holds only its placeholder line (the one starting "(Not filled in yet.")');
    expect(c).toMatch(/its example is not a folder/);
  });

  // P2-1: "ask when unreadable" and "move when clear" had no precedence, and the
  // empty case asked where things go even when the request already said it.
  it('defines "place is clear": read and fits one folder, OR the person named it', () => {
    const c = fileFilingSkill.content;
    expect(c).toMatch(
      /A place is clear when you read the document and its content fits one folder, or when the person named the destination or the kind of document in the request/,
    );
    expect(c, 'the request outranks the section').toMatch(/the request outranks "Your folders"/);
  });

  it('an unreadable document is never filed on its name, unless the person named the place', () => {
    const c = fileFilingSkill.content;
    expect(c).toMatch(/its name and extension are no evidence/);
    expect(c).toMatch(
      /say so and ask where it goes, unless the person already named the destination/,
    );
  });

  it('the empty-folders question is skipped when the request already answers it', () => {
    const c = fileFilingSkill.content;
    expect(c).toMatch(
      /unless the request already names the destination or the kind: then file there and ask nothing/,
    );
  });

  it('tells the model what an empty "Your folders" means, and where the owner writes it once', () => {
    const c = fileFilingSkill.content;
    expect(c).toContain('Skills -> File filing -> "Your folders"');
  });

  it('states the rules the owner decided, one by one', () => {
    const c = fileFilingSkill.content;
    expect(c, 'list the destination before moving').toMatch(
      /List the destination folder before moving/,
    );
    expect(c, 'content, not name').toMatch(/by what it IS/);
    expect(c, 'ask on unreadable').toMatch(/cannot \(an image without text, an unreadable file\)/);
    expect(c, 'plan for several files').toMatch(/show the plan[\s\S]*wait for the person's go/);
    expect(c, 'one question').toMatch(/one question, never several/);
    expect(c, 'dated name').toContain('YYYY-MM-DD Subject.ext');
    expect(c, 'never replace').toContain('" (2)", " (3)"');
    expect(c, 'move not copy').toMatch(/Move, never copy/);
    expect(c, 'never delete').toMatch(/Never delete/);
    expect(c, 'report').toMatch(/each file you left in place with the reason/);
  });

  it('stays well under the print skill, the upper bound for a catalog skill', () => {
    const print = systemSkills.find((s) => s.slug === 'print-request');
    expect(print).toBeDefined();
    expect(fileFilingSkill.content.length).toBeLessThan(print!.content.length * 0.75);
  });
});

describe('file-filing test helpers (the tests above are only as good as these)', () => {
  it('a section holding a folder is NOT empty', () => {
    const filled = `${FILE_FILING_FOLDERS_HEADING}\n<!-- hint -->\n\`Documents/Health\` -> medical records\n`;
    expect(writtenFolders(foldersSection(filled))).toContain('Documents/Health');
  });

  it.each([
    ['a drive letter', 'put it in C:\\Users\\someone\\Documents'],
    ['a forward-slash drive', 'put it in D:/Docs'],
    ['a UNC share', 'put it in \\\\server\\share'],
    ['a home folder', 'put it in ~/Documents'],
    ['a POSIX home', 'put it in /home/someone/docs'],
  ])('the path scan catches %s', (_label, text) => {
    expect(text).toMatch(ABSOLUTE_PATH);
  });

  it('the path scan lets a relative example through', () => {
    expect('`Documents/Health` -> medical records, "Skills -> File filing"').not.toMatch(
      ABSOLUTE_PATH,
    );
  });
});
