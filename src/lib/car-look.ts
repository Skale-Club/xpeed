// How a car is drawn in the app: its body shape and colour. The drawing is a
// generic silhouette of that kind of car, painted in the owner's colour, so
// people recognise "that's mine" without pictures of real models. An owner's
// own photo, when there is one, takes its place.

export const BODY_TYPES = ['hatch', 'sedan', 'suv', 'pickup', 'wagon', 'minivan', 'coupe'] as const;
export type BodyType = (typeof BODY_TYPES)[number];

export const CAR_COLORS = [
  { key: 'white', hex: '#ECEDEF' },
  { key: 'silver', hex: '#B5BAC1' },
  { key: 'gray', hex: '#6E747C' },
  { key: 'black', hex: '#25272B' },
  { key: 'red', hex: '#C8322F' },
  { key: 'wine', hex: '#7A2232' },
  { key: 'blue', hex: '#2F5FAF' },
  { key: 'navy', hex: '#24345A' },
  { key: 'green', hex: '#3F7A4E' },
  { key: 'beige', hex: '#CDB892' },
  { key: 'brown', hex: '#6C4A33' },
  { key: 'yellow', hex: '#E6C33A' },
  { key: 'orange', hex: '#DE7A2C' },
] as const;
export type CarColor = (typeof CAR_COLORS)[number]['key'];

/** A neutral grey for cars whose colour we don't know yet. */
export const DEFAULT_COLOR: CarColor = 'silver';

export function colorHex(color: string | null | undefined): string {
  return CAR_COLORS.find((c) => c.key === color)?.hex ?? CAR_COLORS.find((c) => c.key === DEFAULT_COLOR)!.hex;
}

export function isBodyType(value: unknown): value is BodyType {
  return typeof value === 'string' && (BODY_TYPES as readonly string[]).includes(value);
}

export function isCarColor(value: unknown): value is CarColor {
  return typeof value === 'string' && CAR_COLORS.some((c) => c.key === value);
}

/** NHTSA's "Body Class" (from the VIN) → our shapes. */
export function bodyTypeFromNhtsa(bodyClass: string | null | undefined): BodyType | null {
  const b = (bodyClass ?? '').toLowerCase();
  if (!b) return null;
  if (b.includes('pickup')) return 'pickup';
  if (b.includes('minivan') || b === 'van' || b.includes('cargo van') || b.includes('passenger van')) return 'minivan';
  if (b.includes('sport utility') || b.includes('suv') || b.includes('crossover') || b.includes('cuv') || b.includes('mpv')) return 'suv';
  if (b.includes('wagon')) return 'wagon';
  if (b.includes('hatchback') || b.includes('liftback')) return 'hatch';
  if (b.includes('coupe') || b.includes('convertible') || b.includes('cabriolet') || b.includes('roadster')) return 'coupe';
  if (b.includes('sedan') || b.includes('saloon')) return 'sedan';
  return null;
}

// Best sellers in Brazil and the US, so most cars get the right shape without asking.
const MODEL_BODY: [RegExp, BodyType][] = [
  [/\b(onix plus|prisma|cobalt|cruze|virtus|jetta|voyage|cronos|grand siena|siena|corolla(?! cross)|civic|city|accord|camry|sentra|versa|hb20s|logan|yaris sedan|elantra|sonata|altima|malibu|fusion|focus sedan|model 3|passat|a3 sedan|a4|c-class|3 series|lancer|cerato|forte)\b/, 'sedan'],
  [/\b(onix|celta|corsa|gol|polo|up|fox|argo|mobi|uno|palio|ka|fiesta|hb20|sandero|kwid|march|yaris|fit|etios|i30|golf|208|c3|clio|prius|leaf|bolt|mini|focus|a3|matiz|spark|sonic|swift|mazda3|kia rio|rio)\b/, 'hatch'],
  [/\b(hilux|strada|toro|saveiro|montana|s10|ranger|amarok|frontier|l200|triton|maverick|f-?150|f-?250|silverado|sierra|tacoma|tundra|ram|colorado|gladiator|oroch|rampage|titano)\b/, 'pickup'],
  [/\b(spin|sienna|odyssey|pacifica|carnival|sedona|grand caravan|caravan|quest|zafira|doblo|livina|meriva|idea|transit|sprinter|master|ducato)\b/, 'minivan'],
  [/\b(parati|spacewagon|weekend|sw|wagon|outback|v60|v90|allroad|avant|touring|estate|variant)\b/, 'wagon'],
  [/\b(mustang|camaro|challenger|corvette|86|gr86|brz|miata|mx-5|z4|tt|911|cayman|boxster|supra|370z|400z|scirocco|tiguan allspace coupe)\b/, 'coupe'],
  [/\b(compass|renegade|commander|creta|tucson|santa fe|t-cross|nivus|taos|tiguan|tracker|equinox|trailblazer|blazer|kicks|hr-?v|cr-?v|wr-?v|rav4|corolla cross|sw4|duster|captur|kardian|pulse|fastback|ecosport|bronco|territory|tiggo|haval|h6|song|yuan|seal u|t40|kona|sportage|sorento|seltos|soul|outlander|eclipse cross|asx|pajero|land cruiser|4runner|highlander|explorer|escape|edge|expedition|tahoe|suburban|wrangler|cherokee|grand cherokee|forester|crosstrek|xv|cx-?3|cx-?30|cx-?5|cx-?9|x1|x3|x5|q3|q5|q7|glc|gle|xc40|xc60|xc90|model y|model x|2008|3008|5008|c4 cactus|aircross|tera|bz4x)\b/, 'suv'],
];

/** A best guess from the model name, for cars added without a chassis number. */
export function guessBodyType(model: string | null | undefined): BodyType | null {
  const m = ` ${(model ?? '').toLowerCase().trim()} `;
  if (!m.trim()) return null;
  // SUVs and pickups first: "Corolla Cross", "Ram" and "Up" must not fall into broader groups.
  for (const type of ['pickup', 'suv', 'minivan', 'coupe', 'wagon', 'sedan', 'hatch'] as const) {
    for (const [re, body] of MODEL_BODY) {
      if (body === type && re.test(m)) return body;
    }
  }
  return null;
}

/** The shape to draw for a car: what the owner chose, else a guess, else a sedan. */
export function carBodyType(car: { body_type?: string | null; model?: string | null }): BodyType {
  return isBodyType(car.body_type) ? car.body_type : guessBodyType(car.model) ?? 'sedan';
}
