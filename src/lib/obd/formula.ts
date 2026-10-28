// Torque-style PID equations, e.g. "(A*256+B)*79.99/65535", "SIGNED(A)-40",
// "{B:3}", "MAX(A,B)-MIN(A,B)". A..Z are reply bytes 0..25, AA..AZ are 26..51.
// Parsed with a small recursive-descent parser — never eval'd.

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'byte'; index: number }
  | { kind: 'bit'; index: number; bit: number }
  | { kind: 'neg'; arg: Node }
  | { kind: 'signed'; arg: Node }
  | { kind: 'fn'; name: 'MAX' | 'MIN'; args: Node[] }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/'; left: Node; right: Node };

export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}

function byteIndex(name: string): number {
  if (name.length === 1) return name.charCodeAt(0) - 65;
  return (name.charCodeAt(0) - 64) * 26 + (name.charCodeAt(1) - 65);
}

function tokenize(src: string): string[] {
  const tokens = src.toUpperCase().match(/\d+(?:\.\d+)?|SIGNED|MAX|MIN|[A-Z]+|[-+*/(){}:,]|\S/g) ?? [];
  for (const t of tokens) {
    if (!/^(\d+(\.\d+)?|SIGNED|MAX|MIN|[A-Z]{1,2}|[-+*/(){}:,])$/.test(t)) throw new FormulaError(`Unexpected "${t}"`);
  }
  return tokens;
}

function parse(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (expected?: string) => {
    const t = tokens[pos++];
    if (t === undefined) throw new FormulaError('Unexpected end of formula');
    if (expected && t !== expected) throw new FormulaError(`Expected "${expected}" but got "${t}"`);
    return t;
  };

  function primary(): Node {
    const t = take();
    if (/^\d/.test(t)) return { kind: 'num', value: Number(t) };
    if (t === 'SIGNED') {
      take('(');
      const arg = expr();
      take(')');
      return { kind: 'signed', arg };
    }
    if (t === 'MAX' || t === 'MIN') {
      take('(');
      const args = [expr()];
      while (peek() === ',') {
        take();
        args.push(expr());
      }
      take(')');
      return { kind: 'fn', name: t, args };
    }
    if (/^[A-Z]{1,2}$/.test(t)) return { kind: 'byte', index: byteIndex(t) };
    if (t === '(') {
      const inner = expr();
      take(')');
      return inner;
    }
    if (t === '{') {
      const name = take();
      if (!/^[A-Z]{1,2}$/.test(name)) throw new FormulaError(`Expected a byte letter but got "${name}"`);
      take(':');
      const bit = Number(take());
      if (!Number.isInteger(bit) || bit < 0 || bit > 7) throw new FormulaError('Bit must be 0–7');
      take('}');
      return { kind: 'bit', index: byteIndex(name), bit };
    }
    throw new FormulaError(`Unexpected "${t}"`);
  }

  function unary(): Node {
    if (peek() === '-') {
      take();
      return { kind: 'neg', arg: unary() };
    }
    return primary();
  }

  function term(): Node {
    let node = unary();
    while (peek() === '*' || peek() === '/') {
      const op = take() as '*' | '/';
      node = { kind: 'bin', op, left: node, right: unary() };
    }
    return node;
  }

  function expr(): Node {
    let node = term();
    while (peek() === '+' || peek() === '-') {
      const op = take() as '+' | '-';
      node = { kind: 'bin', op, left: node, right: term() };
    }
    return node;
  }

  const root = expr();
  if (pos < tokens.length) throw new FormulaError(`Unexpected "${tokens[pos]}"`);
  return root;
}

function evaluate(node: Node, bytes: number[]): number {
  switch (node.kind) {
    case 'num': return node.value;
    case 'byte': return node.index < bytes.length ? bytes[node.index] : NaN;
    case 'bit': return node.index < bytes.length ? (bytes[node.index] >> node.bit) & 1 : NaN;
    case 'neg': return -evaluate(node.arg, bytes);
    case 'signed': {
      const v = evaluate(node.arg, bytes);
      return v > 127 ? v - 256 : v;
    }
    case 'fn': {
      const vals = node.args.map((a) => evaluate(a, bytes));
      return node.name === 'MAX' ? Math.max(...vals) : Math.min(...vals);
    }
    case 'bin': {
      const l = evaluate(node.left, bytes);
      const r = evaluate(node.right, bytes);
      if (node.op === '+') return l + r;
      if (node.op === '-') return l - r;
      if (node.op === '*') return l * r;
      return l / r;
    }
  }
}

/** Compile a formula; throws FormulaError on bad syntax. */
export function compileFormula(src: string): (bytes: number[]) => number | null {
  if (!src.trim()) throw new FormulaError('Formula is empty');
  const root = parse(src);
  return (bytes) => {
    const v = evaluate(root, bytes);
    return Number.isFinite(v) ? v : null;
  };
}
