/// <reference types="vite/client" />

// `Intl.supportedValuesOf` is part of ES2023 but not yet in the default lib
// shipped with our TypeScript baseline. Declare it here so consumers don't
// need to reach for `@ts-ignore` or cast `Intl` to `any`.
declare namespace Intl {
  type SupportedValuesKey =
    | 'calendar'
    | 'collation'
    | 'currency'
    | 'numberingSystem'
    | 'timeZone'
    | 'unit';
  function supportedValuesOf(key: SupportedValuesKey): string[];
}
