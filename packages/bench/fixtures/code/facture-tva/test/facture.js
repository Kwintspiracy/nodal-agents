import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totalFacture } from '../src/facture.js';

test('une ligne à 20 %', () => {
  assert.deepEqual(totalFacture([{ quantite: 2, prixUnitaire: 10 }], 20), {
    ht: 20,
    tva: 4,
    ttc: 24,
  });
});

test('arrondi au centime le plus proche', () => {
  assert.deepEqual(totalFacture([{ quantite: 5, prixUnitaire: 2.5 }], 5.5), {
    ht: 12.5,
    tva: 0.69,
    ttc: 13.19,
  });
});

test('une facture vide', () => {
  assert.deepEqual(totalFacture([], 20), { ht: 0, tva: 0, ttc: 0 });
});
