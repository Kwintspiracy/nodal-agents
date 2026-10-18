import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugTitre } from '../src/slug.js';

test('accents, ponctuation et majuscules', () => {
  assert.equal(slugTitre('Été à Paris !'), 'ete-a-paris');
});

test('espaces multiples', () => {
  assert.equal(slugTitre('  Le   Grand  Café  '), 'le-grand-cafe');
});

test('apostrophes et ligatures', () => {
  assert.equal(slugTitre("L'œuvre d'art"), 'loeuvre-dart');
});
