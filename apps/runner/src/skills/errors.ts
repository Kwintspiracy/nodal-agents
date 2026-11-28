// skills/errors.ts — the refusal every skill-store operation throws. Its own
// module so install.ts and manifest.ts can both throw it without importing
// each other. Re-exported from install.ts (and the barrel) as before.

export class SkillInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillInstallError';
  }
}
