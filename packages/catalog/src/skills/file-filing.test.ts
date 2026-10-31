// file-filing.test.ts — the skill carries a METHOD and no folder (invariants #1, #6).
//
// The folders are the owner's: each install writes its own tree in the "Your
// folders" section. These tests hold the two promises that make that safe: the
// shipped text names no real place, and the section the owner fills in is
// there and empty.

import { describe, it, expect } from 'vitest';
import { systemSkills, systemSkillSlugs } from '../index';
import { fileFilingSkill, FILE_FILING_FOLDERS_HEADING } from './file-filing';

/** The body of "Your folders": everything after its heading, up to the next heading. */
function foldersSection(content: string): string {
  const at = content.indexOf(FILE_FILING_FOLDERS_HEADING);
  if (at < 0) throw new Error('the "Your folders" section is gone');
  const rest = content.slice(at + FILE_FILING_FOLDERS_HEADING.length);
  const next = rest.search(/\n#{1,6} /);
  return next < 0 ? rest : rest.slice(0, next);
}

/** What a person (or the model) would call "written" in that section: text outside HTML comments. */
function writtenFolders(section: string): string {
  return section.replace(/<!--[\s\S]*?-->/g, '').trim();
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
    expect(section, 'the section no longer tells the owner what to write').toMatch(
      /<!--[\s\S]+-->/,
    );
    expect(writtenFolders(section), 'a folder is shipped in the catalog').toBe('');
    // The instruction names a relative example only.
    expect(section).toMatch(/Example/);
  });

  it('tells the model what an empty "Your folders" means, and where the owner writes it once', () => {
    const c = fileFilingSkill.content;
    expect(c).toMatch(/holds only its instruction comment/);
    expect(c).toContain('Skills -> File filing -> "Your folders"');
  });

  it('states the rules the owner decided, one by one', () => {
    const c = fileFilingSkill.content;
    expect(c, 'list the destination before moving').toMatch(
      /List the destination folder before moving/,
    );
    expect(c, 'content, not name').toMatch(/by what it IS/);
    expect(c, 'ask on unreadable').toMatch(
      /cannot \(an image without text, an unreadable file\), say so and ask/,
    );
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
    expect(fileFilingSkill.content.length).toBeLessThan(print!.content.length / 1.5);
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
