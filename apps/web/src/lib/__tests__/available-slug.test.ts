// available-slug.test.ts — a second agent from the same profile must not be
// pre-filled with a slug the workspace already has (codex, PR #45 third pass:
// an unchanged submission failed with `conflict`).

import { describe, it, expect } from 'vitest';
import { availableSlug, nameForSlug } from '../available-slug.ts';

describe('availableSlug', () => {
  it('keeps the base when nothing collides', () => {
    expect(availableSlug('developer', ['code-reviewer'])).toBe('developer');
  });

  it('numbers from 2 when the base is taken, skipping taken numbers', () => {
    expect(availableSlug('developer', ['developer'])).toBe('developer-2');
    expect(availableSlug('developer', ['developer', 'developer-2', 'developer-3'])).toBe(
      'developer-4',
    );
  });

  it('compares case-insensitively — slugs are lower-case in the DB', () => {
    expect(availableSlug('developer', ['Developer'])).toBe('developer-2');
  });
});

describe('nameForSlug', () => {
  it('follows the slug count', () => {
    expect(nameForSlug('Developer', 'developer', 'developer')).toBe('Developer');
    expect(nameForSlug('Developer', 'developer', 'developer-3')).toBe('Developer 3');
  });
});
