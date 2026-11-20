import { describe, expect, it } from 'vitest';
import { initialsOf } from './initials';

describe('initialsOf', () => {
  it('takes the first letter of the first two words, in capitals', () => {
    expect(initialsOf('Skale Club')).toBe('SC');
    expect(initialsOf('ana')).toBe('A');
    expect(initialsOf('motorista.exemplo@x.com')).toBe('ME');
    expect(initialsOf('   ')).toBe('?');
  });
});
