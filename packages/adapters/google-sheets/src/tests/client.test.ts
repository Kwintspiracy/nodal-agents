// @nodalai/adapter-google-sheets — client factory tests

import { describe, it, expect } from 'vitest';
import { createSheetsClient } from '../client';

describe('createSheetsClient', () => {
  it('returns a sheets_v4.Sheets instance with a spreadsheets resource', () => {
    const sheets = createSheetsClient('fake_access_token');
    expect(sheets).toBeDefined();
    expect(typeof sheets.spreadsheets).toBe('object');
    expect(typeof sheets.spreadsheets.values).toBe('object');
    expect(typeof sheets.spreadsheets.values.get).toBe('function');
    expect(typeof sheets.spreadsheets.values.update).toBe('function');
    expect(typeof sheets.spreadsheets.values.append).toBe('function');
  });

  it('creates distinct instances per call', () => {
    const a = createSheetsClient('token_a');
    const b = createSheetsClient('token_b');
    expect(a).not.toBe(b);
  });

  it('accepts any string as accessToken (validation is API-side)', () => {
    expect(() => createSheetsClient('any-token')).not.toThrow();
  });

  it('exposes batchUpdate and get on spreadsheets', () => {
    const sheets = createSheetsClient('token');
    expect(typeof sheets.spreadsheets.batchUpdate).toBe('function');
    expect(typeof sheets.spreadsheets.get).toBe('function');
    expect(typeof sheets.spreadsheets.create).toBe('function');
  });
});
