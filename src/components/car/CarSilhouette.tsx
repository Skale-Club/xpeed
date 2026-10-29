import { useId } from 'react';
import { cn } from '@/lib/utils';
import { colorHex, type BodyType } from '@/lib/car-look';

// Side views of each kind of car, facing left, on a 200×76 canvas: the body
// (painted in the car's colour), the windows, and where the wheels sit.
// Generic on purpose: they say "a grey hatchback", not a brand's design.
type Shape = { body: string; windows: string[]; wheels: [number, number]; r: number; cy?: number; head: [number, number]; tail: [number, number] };

const SHAPES: Record<BodyType, Shape> = {
  sedan: {
    body: 'M10 57 C10 50 14 47 24 46 L60 43 C70 34 82 26 100 25 L132 25 C146 25 156 34 166 42 L184 45 C190 46 192 50 192 55 L192 59 C192 62 190 63 187 63 L13 63 C11 63 10 61 10 57 Z',
    windows: [
      'M70 42 C78 34 88 29.5 100 29.5 L113 29.5 L113 42 Z',
      'M117 29.5 L131 29.5 C141 29.5 149 35 156 42 L117 42 Z',
    ],
    wheels: [50, 154],
    r: 11,
    head: [11, 48],
    tail: [186, 47],
  },
  hatch: {
    body: 'M24 57 C24 50 28 47 38 46 L66 43 C76 33 88 25 106 24 L146 24 C158 24 166 30 171 39 L176 47 C178 50 178 53 178 56 L178 59 C178 62 176 63 173 63 L27 63 C25 63 24 61 24 57 Z',
    windows: [
      'M76 42 C84 33 94 28.5 106 28.5 L123 28.5 L123 42 Z',
      'M127 28.5 L145 28.5 C155 28.5 162 33 166 42 L127 42 Z',
    ],
    wheels: [58, 148],
    r: 11.5,
    head: [25, 48],
    tail: [173, 45],
  },
  suv: {
    body: 'M10 52 C10 41 14 37 24 36 L50 34 C58 24 68 12 88 11 L162 11 C173 11 180 18 184 27 L188 38 C190 42 191 46 191 49 L191 54 C191 57 189 58 186 58 L13 58 C11 58 10 56 10 52 Z',
    windows: [
      'M60 33 C66 23 74 16 88 16 L119 16 L119 33 Z',
      'M123 16 L160 16 C169 16 175 22 178 33 L123 33 Z',
    ],
    wheels: [48, 156],
    r: 13.5,
    cy: 60,
    head: [11, 41],
    tail: [186, 40],
  },
  pickup: {
    body: 'M8 57 C8 48 12 45 22 44 L50 42 C58 31 66 20 84 19 L118 19 C124 19 126 22 126 28 L126 40 L190 40 C192 40 193 42 193 44 L193 59 C193 62 191 63 188 63 L11 63 C9 63 8 61 8 57 Z',
    windows: [
      'M60 40 C66 31 72 24 84 24 L101 24 L101 40 Z',
      'M105 24 L118 24 C121 24 121.5 26 121.5 30 L121.5 40 L105 40 Z',
    ],
    wheels: [48, 160],
    r: 12.5,
    head: [9, 48],
    tail: [189, 44],
  },
  wagon: {
    body: 'M10 57 C10 50 14 47 24 46 L60 43 C70 34 82 26 100 25 L176 25 C182 25 186 30 188 38 L190 46 C191 50 192 53 192 56 L192 59 C192 62 190 63 187 63 L13 63 C11 63 10 61 10 57 Z',
    windows: [
      'M70 42 C78 34 88 29.5 100 29.5 L119 29.5 L119 42 Z',
      'M123 29.5 L151 29.5 L151 42 L123 42 Z',
      'M155 29.5 L174 29.5 C179 29.5 182 33 183 42 L155 42 Z',
    ],
    wheels: [50, 156],
    r: 11,
    head: [11, 48],
    tail: [187, 44],
  },
  minivan: {
    body: 'M10 57 C10 50 14 46 22 45 L40 42 C48 28 60 15 84 14 L172 14 C182 14 188 20 189 30 L190 46 C191 50 191 53 191 56 L191 59 C191 62 189 63 186 63 L13 63 C11 63 10 61 10 57 Z',
    windows: [
      'M50 40 C56 28 66 19 84 19 L113 19 L113 40 Z',
      'M117 19 L148 19 L148 40 L117 40 Z',
      'M152 19 L172 19 C180 19 184 24 184 32 L184 40 L152 40 Z',
    ],
    wheels: [48, 156],
    r: 12,
    head: [11, 48],
    tail: [186, 42],
  },
  coupe: {
    body: 'M10 57 C10 51 14 48 24 47 L66 44 C78 34 92 29 108 29 L124 29 C140 29 154 37 170 44 L186 47 C190 48 192 51 192 55 L192 59 C192 62 190 63 187 63 L13 63 C11 63 10 61 10 57 Z',
    windows: [
      'M76 43 C86 36.5 96 33.5 108 33.5 L121 33.5 L121 43 Z',
      'M125 33.5 C137 33.5 146 38 156 43 L125 43 Z',
    ],
    wheels: [52, 152],
    r: 11,
    head: [11, 50],
    tail: [186, 48],
  },
};

/** Light paint needs a darker outline to stand out on a light card, dark paint a lighter one. */
function isDark(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b < 110;
}

export function CarSilhouette({ bodyType, color, className, title }: {
  bodyType: BodyType;
  color?: string | null;
  className?: string;
  /** What screen readers hear; leave out when the car's name is already next to it. */
  title?: string;
}) {
  const shape = SHAPES[bodyType];
  const paint = colorHex(color);
  const dark = isDark(paint);
  const shine = useId();
  const cy = shape.cy ?? 62;
  return (
    <svg
      viewBox="0 0 200 76"
      className={cn('h-auto w-full', className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-testid="car-silhouette"
      data-body={bodyType}
    >
      <defs>
        {/* A soft light from above, so the paint doesn't look flat. */}
        <linearGradient id={shine} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity={dark ? 0.18 : 0.35} />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.22" />
        </linearGradient>
      </defs>
      <ellipse cx="101" cy="70" rx="88" ry="4" fill="#000" opacity="0.35" />
      <path d={shape.body} fill={paint} stroke={dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.35)'} strokeWidth="1" strokeLinejoin="round" />
      <path d={shape.body} fill={`url(#${shine})`} />
      {shape.windows.map((d) => (
        <path key={d} d={d} fill="#1A2230" opacity="0.92" />
      ))}
      {/* Headlight at the front, tail light at the back. */}
      <rect x={shape.head[0]} y={shape.head[1]} width="7" height="3" rx="1.5" fill="#F4F1DE" opacity="0.9" />
      <rect x={shape.tail[0]} y={shape.tail[1]} width="4" height="4" rx="1.2" fill="#D23B33" />
      {shape.wheels.map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy={cy} r={shape.r + 2} fill="hsl(var(--card))" />
          <circle cx={cx} cy={cy} r={shape.r} fill="#16181C" />
          <circle cx={cx} cy={cy} r={shape.r * 0.56} fill="#8A9099" />
          <circle cx={cx} cy={cy} r={shape.r * 0.2} fill="#3A3F46" />
        </g>
      ))}
    </svg>
  );
}
