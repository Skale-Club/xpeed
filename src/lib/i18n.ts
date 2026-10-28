import i18n, { type BackendModule } from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Each locale file is ~40 KB. They are loaded on demand: only the active
// language is fetched at startup, the others when the user switches to them.
// i18n.changeLanguage() resolves after the new language has been loaded, so
// `await i18n.changeLanguage('en')` followed by t() works as before.
const loaders: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  en: () => import('@/locales/en.json'),
  'pt-BR': () => import('@/locales/pt-BR.json'),
  'es-ES': () => import('@/locales/es-ES.json'),
};

const lazyLocales: BackendModule = {
  type: 'backend',
  init() { /* nothing to set up */ },
  read(language, _namespace, callback) {
    const load = loaders[language];
    if (!load) {
      callback(null, {});
      return;
    }
    load().then((m) => callback(null, m.default), (err) => callback(err as Error, null));
  },
};

/** Resolves once the starting language is loaded; render the app after this. */
export const i18nReady: Promise<unknown> = i18n
  .use(lazyLocales)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // 'en' is only used to resolve an unsupported browser language. It is not
    // a per-key fallback (that would download English next to every other
    // language); the three locale files are kept key-for-key identical by
    // src/lib/i18n.test.ts instead.
    fallbackLng: (code?: string) => (code ? [] : ['en']),
    supportedLngs: ['en', 'pt-BR', 'es-ES'],
    interpolation: {
      escapeValue: false, // React already escapes
    },
    react: { useSuspense: false },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'app_language',
    },
  });

export default i18n;
