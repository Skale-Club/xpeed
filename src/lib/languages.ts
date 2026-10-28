/** The app's languages, with the country whose flag stands for each. */
export const LANGUAGES = [
  { code: 'en', label: 'English', iso: 'US' },
  { code: 'pt-BR', label: 'Português', iso: 'BR' },
  { code: 'es-ES', label: 'Español', iso: 'ES' },
] as const;

export type Language = (typeof LANGUAGES)[number];

/** The language in use ("pt" matches "pt-BR"), English when none matches. */
export function currentLanguage(resolved: string | undefined): Language {
  return LANGUAGES.find((l) => resolved?.startsWith(l.code.split('-')[0])) ?? LANGUAGES[0];
}
