// catalog/skills/file-filing.ts — system skill, shipped with the product.
//
// Source of truth for the 'content' field. The bootstrap seeder
// (seed-default-skills.ts) upserts this row at boot. Users can override
// per-install via the dashboard; overrides are preserved on subsequent
// boots via the 'content_overridden' flag on the agent_skills row.
//
// WHY (owner's decision, 2026-10-31): agents can now move files (`file_move`).
// Nothing told them HOW to file a document: where it goes, what to call it, what
// not to break, what to report. This skill carries the METHOD and no folder at
// all (invariant #6): each install writes its own tree in the "Your folders"
// section at the end. A skill costs one line in the prompt until it is loaded
// (`skill_view`), so the method weighs nothing on a turn that is not about
// filing, which per-agent configuration would.
//
// The "Your folders" section starts with a VISIBLE PLACEHOLDER LINE, not an HTML
// comment (review of #895, P2-2). The skills screen edits the content in a plain
// textarea and `skill_view` hands the text to the model as it is: nothing
// renders or strips markup, so both read the same characters. A comment has an
// inside, and the owner who writes his folders inside it is read as "empty" by
// the method (and asked again forever). A line has no inside: the owner replaces
// it, or writes under it, and anything beyond the line counts as written.

import type { SystemSkill } from '../types';

/**
 * The heading of the section each install fills in. Exported so the test reads
 * the same word the skill uses (and so the seeded text cannot drift from it).
 */
export const FILE_FILING_FOLDERS_HEADING = '## Your folders';

/**
 * The line "Your folders" ships with. The method defines "empty" by this line
 * (it quotes its first words), and the test reads the same constant.
 */
export const FILE_FILING_PLACEHOLDER =
  '(Not filled in yet. Replace this line with one line per folder: its path -> what goes in it. Example: Documents/Health -> medical records, prescriptions.)';

export const fileFilingSkill: SystemSkill = {
  slug: 'file-filing',
  name: 'File filing',
  description:
    'Use to file, sort, tidy, rename or put away documents, or to place one just produced (a scan, a download): where it goes, its name, what to report.',
  requiredBuiltins: [],
  content: `# File filing

How to put documents where they belong. The folders are the owner's: they are written in "Your folders" at the end of this skill.

## Method
1. **Where things go.** The destinations come from "Your folders" and from the real tree. List the destination folder before moving anything into it: a folder may have been added or renamed since the section was written. A document fits a folder by what it IS (its content), not by its file name or its extension.
2. **Read before deciding.** Read the document's text when it can be read. When it cannot (an image without text, an unreadable file), its name and extension are no evidence: say so and ask where it goes, unless the person already named the destination.
3. **Act or propose.** A place is clear when you read the document and its content fits one folder, or when the person named the destination or the kind of document in the request (the request outranks "Your folders"). One file whose place is clear: move it. Several files, or a place that is not clear: show the plan (each file -> destination, new name) and wait for the person's go. When no folder fits, put a proposal (an existing folder or a new subfolder) in that same question: one question, never several.
4. **Names.** Keep the original name when it says what the document is. A meaningless name (scanner or camera numbering, "document(3)") becomes \`YYYY-MM-DD Subject.ext\`: the date the document itself states, otherwise the file's date; the same extension; no character that Windows, macOS or Linux refuses (\\ / : * ? " < > |).
5. **Never replace a file.** A move onto a name that already exists overwrites it. If the destination already holds that name, add " (2)", " (3)"... before the extension.
6. **Move, never copy**, unless the person asks for a copy. **Never delete.**
7. **Report** when you are done: each file and where it now is, and each file you left in place with the reason.

## When "Your folders" is empty
If the section below holds only its placeholder line (the one starting "(Not filled in yet."), you do not know this person's tree, and its example is not a folder. Ask where each kind of document goes (one question covering the files at hand), unless the request already names the destination or the kind: then file there and ask nothing. Either way, tell the person they can write it once in this skill (Skills -> File filing -> "Your folders") so they are not asked again.

${FILE_FILING_FOLDERS_HEADING}
${FILE_FILING_PLACEHOLDER}
`,
};
