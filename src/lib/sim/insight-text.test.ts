import { afterAll, describe, expect, it } from 'vitest';
import i18n from '@/lib/i18n';
import { buildSyntheticLap, exampleCorners, type SynthCorner } from '@/lib/sim/synthetic-lap';
import { lapInsights, sessionInsights, type Insight, type InsightCause } from '@/lib/sim/insights';
import { insightText, sessionFindingText, sessionFindings, type InsightText, type SessionFinding } from '@/lib/sim/insight-text';

const LANGUAGES = ['en', 'pt-BR', 'es-ES'] as const;

async function say(text: InsightText, language: (typeof LANGUAGES)[number]): Promise<string> {
  await i18n.changeLanguage(language);
  return i18n.t(text.key, text.values) as string;
}

const corner = (cause: InsightCause, extra: Partial<Insight> = {}): Insight => ({
  kind: 'lostInCorner', corner: 4, seconds: 0.213, severity: 'high', cause, confidence: 0.8, ...extra,
});

/** Each finding the library can produce with the sentence it must become, in the three languages. */
const CASES: Array<{ name: string; insight: Insight; missing?: Array<'brake' | 'throttle' | 'position'>; en: string; pt: string; es: string }> = [
  {
    name: 'brakeEarlier', insight: { ...corner('brakesEarly', { meters: 14 }), kind: 'brakeEarlier' },
    en: 'You lose 0.21 s in corner 4: you brake 14 m earlier than the reference.',
    pt: 'Você perde 0.21 s na curva 4: você freia 14 m mais cedo que a referência.',
    es: 'Pierdes 0.21 s en la curva 4: frenas 14 m antes que la referencia.',
  },
  {
    name: 'brakesLate that cost minimum speed', insight: corner('brakesLate', { meters: 9, kmh: 5 }),
    en: 'You lose 0.21 s in corner 4: you brake 9 m later, but your slowest point is 5 km/h lower.',
    pt: 'Você perde 0.21 s na curva 4: você freia 9 m mais tarde, mas seu ponto mais lento é 5 km/h menor.',
    es: 'Pierdes 0.21 s en la curva 4: frenas 9 m más tarde, pero tu punto más lento es 5 km/h menor.',
  },
  {
    name: 'brakesLate that cost time after the apex', insight: corner('brakesLate', { meters: 9, kmh: -2 }),
    en: 'You lose 0.21 s in corner 4: you brake 9 m later than the reference, and it costs you time later in the corner.',
    pt: 'Você perde 0.21 s na curva 4: você freia 9 m mais tarde que a referência, e isso custa tempo mais adiante na curva.',
    es: 'Pierdes 0.21 s en la curva 4: frenas 9 m más tarde que la referencia, y eso te cuesta tiempo más adelante en la curva.',
  },
  {
    name: 'lowMinSpeed', insight: corner('lowMinSpeed', { kmh: 6 }),
    en: 'You lose 0.21 s in corner 4: your minimum speed is 6 km/h lower than the reference.',
    pt: 'Você perde 0.21 s na curva 4: sua velocidade mínima é 6 km/h menor que a da referência.',
    es: 'Pierdes 0.21 s en la curva 4: tu velocidad mínima es 6 km/h menor que la de la referencia.',
  },
  {
    name: 'latePickup', insight: corner('latePickup', { meters: 12 }),
    en: 'You lose 0.21 s in corner 4: you get back on the throttle 12 m later than the reference.',
    pt: 'Você perde 0.21 s na curva 4: você volta ao acelerador 12 m mais tarde que a referência.',
    es: 'Pierdes 0.21 s en la curva 4: vuelves al acelerador 12 m más tarde que la referencia.',
  },
  {
    name: 'line', insight: corner('line', { meters: 2.4 }),
    en: 'You lose 0.21 s in corner 4: your line is 2 m away from the reference at the apex.',
    pt: 'Você perde 0.21 s na curva 4: sua linha fica 2 m longe da referência no ápice.',
    es: 'Pierdes 0.21 s en la curva 4: tu trazada queda a 2 m de la referencia en el vértice.',
  },
  {
    name: 'wrongGear', insight: corner('wrongGear'),
    en: 'You lose 0.21 s in corner 4: you use a different gear at the apex than the reference.',
    pt: 'Você perde 0.21 s na curva 4: você usa uma marcha diferente da referência no ápice.',
    es: 'Pierdes 0.21 s en la curva 4: usas una marcha distinta a la de la referencia en el vértice.',
  },
  {
    name: 'slowerExit', insight: { ...corner('slowExit', { kmh: 6 }), kind: 'slowerExit', corner: 7 },
    en: 'You lose 0.21 s in corner 7: your exit speed is 6 km/h lower than the reference.',
    pt: 'Você perde 0.21 s na curva 7: sua velocidade de saída é 6 km/h menor que a da referência.',
    es: 'Pierdes 0.21 s en la curva 7: tu velocidad de salida es 6 km/h menor que la de la referencia.',
  },
  {
    name: 'topSpeedLower', insight: { kind: 'topSpeedLower', corner: null, seconds: 0.07, kmh: 4, severity: 'low' },
    en: 'Your top speed on a straight is 4 km/h lower than the reference, and it costs you 0.07 s.',
    pt: 'Sua velocidade máxima em uma reta é 4 km/h menor que a da referência, e isso custa 0.07 s.',
    es: 'Tu velocidad máxima en una recta es 4 km/h menor que la de la referencia, y eso te cuesta 0.07 s.',
  },
  {
    name: 'sectorGap', insight: { kind: 'sectorGap', corner: null, seconds: 0.18, sector: 2, severity: 'medium' },
    en: 'You lose 0.18 s in sector 2.',
    pt: 'Você perde 0.18 s no setor 2.',
    es: 'Pierdes 0.18 s en el sector 2.',
  },
  {
    name: 'inconsistent', insight: { kind: 'inconsistent', corner: 3, seconds: 0.11, severity: 'medium', kmh: 3 },
    en: 'Corner 3 is where you vary most: its time changes by about 0.11 s from lap to lap.',
    pt: 'A curva 3 é onde você mais varia: o tempo nela muda cerca de 0.11 s de volta para volta.',
    es: 'La curva 3 es donde más varías: su tiempo cambia unos 0.11 s de vuelta en vuelta.',
  },
  {
    name: 'inconsistent with a brake point that moves', insight: { kind: 'inconsistent', corner: 3, seconds: 0.11, severity: 'medium', kmh: 3, meters: 7 },
    en: 'Corner 3 is where you vary most: its time changes by about 0.11 s from lap to lap, and your brake point by about 7 m.',
    pt: 'A curva 3 é onde você mais varia: o tempo nela muda cerca de 0.11 s de volta para volta, e o ponto de frenagem cerca de 7 m.',
    es: 'La curva 3 es donde más varías: su tiempo cambia unos 0.11 s de vuelta en vuelta, y tu punto de frenada unos 7 m.',
  },
  {
    name: 'a loss that nothing measured explains', insight: corner('none', { confidence: undefined }),
    en: 'You lose 0.21 s in corner 4. Nothing we can measure explains it.',
    pt: 'Você perde 0.21 s na curva 4. Nada do que conseguimos medir explica isso.',
    es: 'Pierdes 0.21 s en la curva 4. Nada de lo que podemos medir lo explica.',
  },
  {
    name: 'unknownCause without brake data', insight: corner('unknownCause', { confidence: undefined }), missing: ['brake'],
    en: 'You lose 0.21 s in corner 4. We cannot tell why: no brake data in one of the two laps.',
    pt: 'Você perde 0.21 s na curva 4. Não dá para saber por quê: não há dados de freio em uma das duas voltas.',
    es: 'Pierdes 0.21 s en la curva 4. No podemos saber por qué: no hay datos de freno en una de las dos vueltas.',
  },
  {
    name: 'unknownCause without throttle data', insight: corner('unknownCause', { confidence: undefined }), missing: ['throttle'],
    en: 'You lose 0.21 s in corner 4. We cannot tell why: no throttle data in one of the two laps.',
    pt: 'Você perde 0.21 s na curva 4. Não dá para saber por quê: não há dados de acelerador em uma das duas voltas.',
    es: 'Pierdes 0.21 s en la curva 4. No podemos saber por qué: no hay datos de acelerador en una de las dos vueltas.',
  },
  {
    name: 'unknownCause without position data', insight: corner('unknownCause', { confidence: undefined }), missing: ['position'],
    en: 'You lose 0.21 s in corner 4. We cannot tell why: no position data in one of the two laps.',
    pt: 'Você perde 0.21 s na curva 4. Não dá para saber por quê: não há dados de posição em uma das duas voltas.',
    es: 'Pierdes 0.21 s en la curva 4. No podemos saber por qué: no hay datos de posición en una de las dos vueltas.',
  },
  {
    name: 'unknownCause with the missing channel not known', insight: corner('unknownCause', { confidence: undefined }),
    en: 'You lose 0.21 s in corner 4. We cannot tell why: a channel we need is missing from one of the laps.',
    pt: 'Você perde 0.21 s na curva 4. Não dá para saber por quê: falta um canal necessário em uma das voltas.',
    es: 'Pierdes 0.21 s en la curva 4. No podemos saber por qué: falta un canal necesario en una de las vueltas.',
  },
];

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('the sentence of a finding', () => {
  for (const item of CASES) {
    it(`${item.name}, in English, Portuguese and Spanish`, async () => {
      const text = insightText(item.insight, { missing: item.missing });
      expect(await say(text, 'en')).toBe(item.en);
      expect(await say(text, 'pt-BR')).toBe(item.pt);
      expect(await say(text, 'es-ES')).toBe(item.es);
    });
  }

  it('is a pure function of the finding: same finding, same key and values', () => {
    const finding = corner('lowMinSpeed', { kmh: 6 });
    expect(insightText(finding)).toEqual(insightText({ ...finding }));
    expect(insightText(finding).key).toBe('modes.analysis.insight.lowMinSpeed');
  });

  it('says speeds and distances in the units the person chose', async () => {
    const text = insightText(corner('lowMinSpeed', { kmh: 16.09344 }), { unit: 'mi' });
    expect(text.values.speed).toBe('10 mph');
    expect(insightText({ ...corner('brakesEarly', { meters: 10 }), kind: 'brakeEarlier' }, { unit: 'mi' }).values.distance).toBe('33 ft');
  });

  it('never names a cause its number is missing for', () => {
    // A late pickup with no distance, a low minimum speed with no speed, and so on: the sentence says only what is known.
    for (const cause of ['brakesLate', 'lowMinSpeed', 'latePickup', 'line', 'slowExit'] as const) {
      expect(insightText(corner(cause)).key).toBe('modes.analysis.insight.cornerNoCause');
    }
    expect(insightText({ ...corner('brakesEarly'), kind: 'brakeEarlier' }).key).toBe('modes.analysis.insight.cornerNoCause');
  });

  it('has a sentence in every language for every key it can return', async () => {
    const keys = new Set(CASES.map((item) => insightText(item.insight, { missing: item.missing }).key));
    for (const language of LANGUAGES) {
      await i18n.changeLanguage(language);
      for (const key of keys) {
        expect(i18n.exists(key), `${key} in ${language}`).toBe(true);
        expect(i18n.t(key, { seconds: '0.10', corner: 1, sector: 1, distance: '1 m', speed: '1 km/h' })).not.toMatch(/\{\{|modes\.analysis/);
      }
    }
  });
});

describe('the sentences for real laps', () => {
  const lapWith = (patch: (corners: SynthCorner[]) => SynthCorner[], channels?: Parameters<typeof buildSyntheticLap>[0]['channels']) =>
    buildSyntheticLap({ lengthM: 4200, corners: patch(exampleCorners()), hz: 20, channels }).lap;
  const reference = lapWith((c) => c);

  it('writes the hairpin brake point as the finding the library gave, in meters', async () => {
    const study = lapWith((corners) => corners.map((c, i) => (i === 1 ? { ...c, brakeDist: 900 - 15 } : c)));
    const [first] = lapInsights(study, reference);
    expect(first.kind).toBe('brakeEarlier');
    const sentence = await say(insightText(first), 'en');
    expect(sentence).toMatch(/^You lose 0\.\d\d s in corner 2: you brake 1\d m earlier than the reference\.$/);
  });

  it('says it cannot tell why, and names the brake, when the lap has no brake data', async () => {
    const channels = ['t', 'dist', 'speed', 'x', 'z', 'gear'] as Parameters<typeof buildSyntheticLap>[0]['channels'];
    // A slower corner on a lap with no pedals: time is lost, and nothing can say why.
    const study = buildSyntheticLap({ lengthM: 4200, corners: exampleCorners().map((c, i) => (i === 1 ? { ...c, brakeDist: 880, minSpeedKmh: 70 } : c)), hz: 20, channels }).lap;
    const found = lapInsights(study, reference).find((item) => item.cause === 'unknownCause');
    expect(found).toBeDefined();
    expect(await say(insightText(found!, { missing: ['brake'] }), 'en')).toMatch(/We cannot tell why: no brake data in one of the two laps\.$/);
  });
});

describe('the sentences about a whole session', () => {
  const spread = { corner: 5, laps: 8, timeStdS: 0.134, minSpeedStdKmh: 2.1, brakePointStdM: 6.2, times: [] };
  const gain = (extra: Partial<{ brakePointM: number | null; minSpeedKmh: number }> = {}) => ({ corner: 2, seconds: 0.187, brakePointM: null, minSpeedKmh: 0.4, ...extra });
  const SESSION: Array<{ name: string; finding: SessionFinding; en: string; pt: string; es: string }> = [
    {
      name: 'the corner varied most, with the brake point', finding: { kind: 'variable', spread },
      en: 'You vary most in corner 5: its time changes by about 0.13 s from lap to lap, and your brake point by about 6 m.',
      pt: 'Você varia mais na curva 5: o tempo nela muda cerca de 0.13 s de volta para volta, e o ponto de frenagem cerca de 6 m.',
      es: 'Donde más varías es la curva 5: su tiempo cambia unos 0.13 s de vuelta en vuelta, y tu punto de frenada unos 6 m.',
    },
    {
      name: 'the corner varied most, brake point steady', finding: { kind: 'variable', spread: { ...spread, brakePointStdM: 1 } },
      en: 'You vary most in corner 5: its time changes by about 0.13 s from lap to lap.',
      pt: 'Você varia mais na curva 5: o tempo nela muda cerca de 0.13 s de volta para volta.',
      es: 'Donde más varías es la curva 5: su tiempo cambia unos 0.13 s de vuelta en vuelta.',
    },
    {
      name: 'the best lap gained braking later', finding: { kind: 'bestVsAverage', gain: gain({ brakePointM: 8 }) },
      en: 'Your best lap gained 0.19 s in corner 2 over your average lap: you braked 8 m later.',
      pt: 'Sua melhor volta ganhou 0.19 s na curva 2 sobre a sua volta média: você freou 8 m mais tarde.',
      es: 'Tu mejor vuelta ganó 0.19 s en la curva 2 sobre tu vuelta media: frenaste 8 m más tarde.',
    },
    {
      name: 'the best lap gained braking earlier', finding: { kind: 'bestVsAverage', gain: gain({ brakePointM: -8 }) },
      en: 'Your best lap gained 0.19 s in corner 2 over your average lap: you braked 8 m earlier.',
      pt: 'Sua melhor volta ganhou 0.19 s na curva 2 sobre a sua volta média: você freou 8 m mais cedo.',
      es: 'Tu mejor vuelta ganó 0.19 s en la curva 2 sobre tu vuelta media: frenaste 8 m antes.',
    },
    {
      name: 'the best lap gained carrying speed', finding: { kind: 'bestVsAverage', gain: gain({ minSpeedKmh: 4 }) },
      en: 'Your best lap gained 0.19 s in corner 2 over your average lap: you carried 4 km/h more through it.',
      pt: 'Sua melhor volta ganhou 0.19 s na curva 2 sobre a sua volta média: você levou 4 km/h a mais por ela.',
      es: 'Tu mejor vuelta ganó 0.19 s en la curva 2 sobre tu vuelta media: llevaste 4 km/h más por ella.',
    },
    {
      name: 'the server\'s sector with the most to gain', finding: { kind: 'sectorGain', sector: 2, seconds: 0.412 },
      en: 'Your best lap loses most in sector 2: it is 0.41 s slower than your best time there in this session.',
      pt: 'Sua melhor volta perde mais no setor 2: ela é 0.41 s mais lenta que o seu melhor tempo nele nesta sessão.',
      es: 'Tu mejor vuelta pierde más en el sector 2: es 0.41 s más lenta que tu mejor tiempo en él en esta sesión.',
    },
    {
      name: 'the server\'s sector that varies most', finding: { kind: 'sectorSpread', sector: 3, seconds: 0.28 },
      en: 'You vary most in sector 3: its time changes by about 0.28 s from lap to lap.',
      pt: 'Você varia mais no setor 3: o tempo nele muda cerca de 0.28 s de volta para volta.',
      es: 'Donde más varías es el sector 3: su tiempo cambia unos 0.28 s de vuelta en vuelta.',
    },
    {
      name: 'the server\'s consistency of the laps', finding: { kind: 'consistency', seconds: 0.64, laps: 6 },
      en: 'Your laps vary by about 0.64 s from one to the next (6 laps).',
      pt: 'Suas voltas variam cerca de 0.64 s de uma para a outra (6 voltas).',
      es: 'Tus vueltas varían unos 0.64 s de una a otra (6 vueltas).',
    },
    {
      name: 'the best lap gained, no cause that is big enough to name', finding: { kind: 'bestVsAverage', gain: gain() },
      en: 'Your best lap gained 0.19 s in corner 2 over your average lap.',
      pt: 'Sua melhor volta ganhou 0.19 s na curva 2 sobre a sua volta média.',
      es: 'Tu mejor vuelta ganó 0.19 s en la curva 2 sobre tu vuelta media.',
    },
  ];
  for (const item of SESSION) {
    it(`${item.name}, in the three languages`, async () => {
      const text = sessionFindingText(item.finding);
      expect(await say(text, 'en')).toBe(item.en);
      expect(await say(text, 'pt-BR')).toBe(item.pt);
      expect(await say(text, 'es-ES')).toBe(item.es);
    });
  }

  it('keeps at most the two findings that matter and leaves out what is noise', () => {
    const result = { mostVariableCorner: spread, biggestGain: { corner: 2, seconds: 0.2, brakePointM: null, minSpeedKmh: 0 } };
    expect(sessionFindings(result).map((f) => f.kind)).toEqual(['variable', 'bestVsAverage']);
    expect(sessionFindings({ mostVariableCorner: { ...spread, timeStdS: 0.01 }, biggestGain: { ...result.biggestGain, seconds: 0.01 } })).toEqual([]);
    expect(sessionFindings({ mostVariableCorner: null, biggestGain: null })).toEqual([]);
  });

  it('works on the findings of a real session', () => {
    const laps = [0, 6, -5, 3, 8, -2].map((shift, i) =>
      buildSyntheticLap({ lengthM: 4200, corners: exampleCorners().map((c, k) => (k === 1 ? { ...c, brakeDist: c.brakeDist + shift } : c)), hz: 20, lapNumber: i + 1 }).lap,
    );
    const found = sessionFindings(sessionInsights(laps));
    expect(found.length).toBeGreaterThan(0);
    for (const finding of found) expect(sessionFindingText(finding).key).toMatch(/^modes\.analysis\.session\./);
  });
});
