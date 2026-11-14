import { describe, expect, it } from 'vitest';
import { avatarHue, filterOptions, fold, handleProblem, initialsOf, lifeSpent, normalizeHandle, ordinal } from './social-utils';

describe('the initials of an avatar', () => {
  it('are the first letters of the first two words of the name, in capitals', () => {
    expect(initialsOf('Anna Apex', 'apex_anna')).toBe('AA');
    expect(initialsOf('rita', 'rookie_rita')).toBe('R');
    expect(initialsOf('Ana Maria da Silva', 'x')).toBe('AM');
    expect(initialsOf('Édson Éder', 'x')).toBe('ÉÉ');
  });

  it('come from the handle when there is no name, or the name looks like an e-mail address or a phone number', () => {
    expect(initialsOf(null, 'late_braker')).toBe('LA');
    expect(initialsOf('', '_x_y')).toBe('XY');
    expect(initialsOf('someone@mail.test', 'quiet_one')).toBe('QU');
    expect(initialsOf('+55 11 98765-4321', 'quiet_one')).toBe('QU');
    expect(initialsOf(null, '___')).toBe('?');
  });

  it('get a colour that never changes for the same handle', () => {
    expect(avatarHue('apex_anna')).toBe(avatarHue('apex_anna'));
    expect(avatarHue('apex_anna')).toBeGreaterThanOrEqual(0);
    expect(avatarHue('apex_anna')).toBeLessThan(360);
    expect(avatarHue('apex_anna')).not.toBe(avatarHue('turbo_tiago'));
  });
});

describe('a handle before it is sent', () => {
  it('is read the way the server reads it: trimmed, without a leading @, in lower case', () => {
    expect(normalizeHandle('  @Apex_Anna ')).toBe('apex_anna');
    expect(normalizeHandle('@@x')).toBe('@x');
  });

  it('is checked for its length and its characters', () => {
    expect(handleProblem('')).toBe('empty');
    expect(handleProblem('ab')).toBe('short');
    expect(handleProblem('abc')).toBeNull();
    expect(handleProblem('a'.repeat(24))).toBeNull();
    expect(handleProblem('a'.repeat(25))).toBe('long');
    expect(handleProblem('has space')).toBe('characters');
    expect(handleProblem('with-dash')).toBe('characters');
    expect(handleProblem('café')).toBe('characters');
    expect(handleProblem('ok_123')).toBeNull();
  });
});

describe('the place of a driver', () => {
  it('is written the way each language writes it', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map((n) => ordinal(n, 'en'))).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
    expect(ordinal(12, 'pt-BR')).toBe('12º');
    expect(ordinal(12, 'es-ES')).toBe('12.º');
  });
});

describe('searching a list', () => {
  it('ignores case and accents and wants every word', () => {
    expect(fold('São Paulo')).toBe('sao paulo');
    const options = [{ label: 'Autódromo José Carlos Pace' }, { label: 'Monza' }, { label: 'Spa-Francorchamps' }];
    expect(filterOptions(options, 'AUTODROMO pace')).toEqual([options[0]]);
    expect(filterOptions(options, 'spa fran')).toEqual([options[2]]);
    expect(filterOptions(options, '')).toHaveLength(3);
    expect(filterOptions(options, 'zzz')).toEqual([]);
  });
});

describe('how much of the life of a share link is gone', () => {
  const link = { createdAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-11-11T00:00:00.000Z', active: true };
  it('is a share of the way from the day it was made to the day it ends, none for a link that never ends', () => {
    expect(lifeSpent(link, Date.parse('2026-11-06T00:00:00.000Z'))).toBe(0.5);
    expect(lifeSpent(link, Date.parse('2026-10-01T00:00:00.000Z'))).toBe(0);
    expect(lifeSpent(link, Date.parse('2026-12-01T00:00:00.000Z'))).toBe(1);
    expect(lifeSpent({ ...link, expiresAt: null }, Date.parse('2026-11-06T00:00:00.000Z'))).toBeNull();
  });
});
