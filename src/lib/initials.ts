/** Up to two letters of a name for the account's avatar ("Skale Club" → "SC", "ana" → "A"). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s._@-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? words[0].slice(0, 1) : words[0].slice(0, 1) + words[1].slice(0, 1);
  return letters.toUpperCase();
}
