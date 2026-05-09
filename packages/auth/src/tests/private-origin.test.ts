import { describe, it, expect } from 'vitest';
import { isPrivateOrigin } from '../lib/private-origin.ts';

describe('isPrivateOrigin', () => {
  describe('loopback', () => {
    it('accepts localhost', () => {
      expect(isPrivateOrigin('http://localhost:3000')).toBe(true);
    });
    it('accepts 127.0.0.1', () => {
      expect(isPrivateOrigin('http://127.0.0.1:3000')).toBe(true);
    });
    it('accepts 127.x.y.z range', () => {
      expect(isPrivateOrigin('http://127.5.5.5:3000')).toBe(true);
    });
    it('accepts ::1 (IPv6 loopback)', () => {
      expect(isPrivateOrigin('http://[::1]:3000')).toBe(true);
    });
    it('is case-insensitive on hostname', () => {
      expect(isPrivateOrigin('http://LOCALHOST:3000')).toBe(true);
    });
  });

  describe('RFC1918 private ranges', () => {
    it('accepts 10.x.x.x', () => {
      expect(isPrivateOrigin('http://10.0.0.5:3000')).toBe(true);
    });
    it('accepts 192.168.x.x', () => {
      expect(isPrivateOrigin('http://192.168.1.42:3000')).toBe(true);
    });
    it('accepts 172.16.x.x (lower bound)', () => {
      expect(isPrivateOrigin('http://172.16.0.1:3000')).toBe(true);
    });
    it('accepts 172.31.x.x (upper bound)', () => {
      expect(isPrivateOrigin('http://172.31.255.255:3000')).toBe(true);
    });
    it('rejects 172.15.x.x (just below 172.16)', () => {
      expect(isPrivateOrigin('http://172.15.0.1:3000')).toBe(false);
    });
    it('rejects 172.32.x.x (just above 172.31)', () => {
      expect(isPrivateOrigin('http://172.32.0.1:3000')).toBe(false);
    });
  });

  describe('public IPs', () => {
    it('rejects 8.8.8.8', () => {
      expect(isPrivateOrigin('http://8.8.8.8:3000')).toBe(false);
    });
    it('rejects example.com', () => {
      expect(isPrivateOrigin('https://example.com')).toBe(false);
    });
    it('rejects subdomain of public domain', () => {
      expect(isPrivateOrigin('https://app.example.com:443')).toBe(false);
    });
    it('rejects host that *contains* a private prefix but is not one', () => {
      expect(isPrivateOrigin('http://10.evil.com:3000')).toBe(false);
    });
  });

  describe('protocols', () => {
    it('accepts https on a private host', () => {
      expect(isPrivateOrigin('https://192.168.1.42')).toBe(true);
    });
    it('rejects file://', () => {
      expect(isPrivateOrigin('file:///etc/passwd')).toBe(false);
    });
    it('rejects javascript:', () => {
      expect(isPrivateOrigin('javascript:alert(1)')).toBe(false);
    });
  });

  describe('invalid input', () => {
    it('rejects null', () => {
      expect(isPrivateOrigin(null)).toBe(false);
    });
    it('rejects undefined', () => {
      expect(isPrivateOrigin(undefined)).toBe(false);
    });
    it('rejects empty string', () => {
      expect(isPrivateOrigin('')).toBe(false);
    });
    it('rejects unparseable input', () => {
      expect(isPrivateOrigin('not-a-url')).toBe(false);
    });
  });
});
