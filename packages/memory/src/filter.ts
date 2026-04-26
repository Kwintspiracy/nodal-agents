// @nodalai/memory — pure in-memory filter helpers

/**
 * Filter memories by skill tags intersection.
 *
 * ## Bug fix (legacy regression)
 *
 * The original KwintAgents memory.py skill-filter applied a skill_tags overlap
 * check to ALL memories including agent-scoped ones. If an agent had NO declared
 * skills (empty skill_tags), every memory was filtered out — the agent saw
 * nothing. This was especially bad for router agents (Ender) who intentionally
 * have zero skill assignments.
 *
 * ## Correct semantics
 *
 * - agentSkillTags is undefined OR empty → return all memories (no filter applied)
 * - agentSkillTags is a non-empty array → return memories whose skill_tags
 *   intersect with agentSkillTags
 * - Memories whose own skill_tags is empty are ALWAYS returned — they are
 *   uncategorized / general purpose and should be visible to every agent
 *
 * @param memories       Array of memory-like objects to filter
 * @param agentSkillTags The skill tags declared for the agent (from DB)
 * @param getMemoryTags  Accessor to get skill_tags from a memory item
 */
export function applySkillFilter<T>(
  memories: T[],
  agentSkillTags: string[] | undefined,
  getMemoryTags: (m: T) => string[],
): T[] {
  // No declared skills (undefined or empty) → no filter; return everything
  if (!agentSkillTags || agentSkillTags.length === 0) {
    return memories;
  }

  const agentTagSet = new Set(agentSkillTags);

  return memories.filter((m) => {
    const memTags = getMemoryTags(m);

    // Memories with empty skill_tags are uncategorized → always returned
    if (memTags.length === 0) {
      return true;
    }

    // Keep memories whose tags intersect the agent's skill set
    return memTags.some((t) => agentTagSet.has(t));
  });
}

/**
 * Filter memories by arbitrary tag list (OR semantics).
 * Returns memories where skill_tags has at least one tag in the given set.
 * If filterTags is empty, returns all memories.
 */
export function filterByTags<T>(
  memories: T[],
  filterTags: string[],
  getMemoryTags: (m: T) => string[],
): T[] {
  if (filterTags.length === 0) {
    return memories;
  }

  const tagSet = new Set(filterTags);

  return memories.filter((m) => {
    const memTags = getMemoryTags(m);
    return memTags.some((t) => tagSet.has(t));
  });
}
