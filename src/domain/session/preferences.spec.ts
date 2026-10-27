import { describe, expect, it } from 'vitest';
import { DEFAULT_LANGUAGE, DEFAULT_TIMEZONE, languageFrom, timezoneFrom } from './preferences.js';

describe('languageFrom', () => {
  it.each([
    ['en', 'en'],
    ['en-US', 'en'],
    ['es_MX', 'es'],
    ['FR', 'fr'],
  ])('maps %s to %s', (input, expected) => {
    expect(languageFrom(input)).toBe(expected);
  });

  it.each([null, undefined, '', 'de', 'pt-BR'])('falls back to Spanish for %s', (input) => {
    expect(languageFrom(input)).toBe(DEFAULT_LANGUAGE);
    expect(DEFAULT_LANGUAGE).toBe('es');
  });
});

describe('timezoneFrom', () => {
  it('keeps the first valid IANA zone', () => {
    expect(timezoneFrom('Not/AZone', 'America/Bogota', 'Europe/Paris')).toBe('America/Bogota');
  });

  it('falls back to Europe/Madrid when none is valid or given', () => {
    expect(timezoneFrom(null, undefined, '')).toBe(DEFAULT_TIMEZONE);
    expect(DEFAULT_TIMEZONE).toBe('Europe/Madrid');
  });
});
