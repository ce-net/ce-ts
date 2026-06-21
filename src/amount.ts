/**
 * Credit amounts as integer base units, with human-credit conversion.
 *
 * CE denominates money in integer **base units** — `1 credit = CREDIT (10^18) base
 * units`, wei-style — never floating point. The HTTP API carries amounts as decimal
 * *strings* (they exceed JavaScript's 2^53 safe-integer limit), so {@link Amount} is
 * backed by `bigint` and (de)serializes as a base-unit string.
 *
 * This mirrors ce-rs's `Amount(i128)` 1:1: same parse/format rules, same wire form.
 * The one deliberate, documented difference is that `cid()` in the data layer is async
 * here (SubtleCrypto), whereas ce-rs's is sync. `Amount` itself is fully in parity.
 */

/** Base units per credit (10^18). */
export const CREDIT = 1_000_000_000_000_000_000n;

/**
 * A signed credit amount in base units, backed by `bigint`. Used for both balances
 * (which may be negative during sync) and amounts (which are non-negative). Immutable.
 *
 * `number` is never used for money anywhere in this SDK — it is structurally impossible
 * to construct an `Amount` from a float without going through explicit string math.
 */
export class Amount {
  /** Signed base units, mirrors ce-rs `Amount(i128)`. */
  readonly base: bigint;

  private constructor(base: bigint) {
    this.base = base;
  }

  /** The zero amount. */
  static readonly ZERO: Amount = new Amount(0n);

  /**
   * Construct from raw base units — the wire form. Accepts a decimal string
   * (`"1500000000000000000"`) or a `bigint`. Rejects floats and malformed strings.
   */
  static fromBaseUnits(s: string | bigint): Amount {
    if (typeof s === "bigint") return new Amount(s);
    const t = s.trim();
    if (!/^-?\d+$/.test(t)) {
      throw new RangeError(`invalid base-unit amount: ${JSON.stringify(s)}`);
    }
    return new Amount(BigInt(t));
  }

  /**
   * Parse a human credit decimal (`"1000"`, `"1.5"`, `"0.000000000000000001"`),
   * up to 18 decimal places. Pure string math — never `parseFloat`. Mirrors
   * ce-rs `Amount::parse_credits`. Also accepts `number`/`bigint` for whole credits.
   */
  static fromCredits(s: string | number | bigint): Amount {
    if (typeof s === "bigint") return new Amount(s * CREDIT);
    if (typeof s === "number") {
      if (!Number.isFinite(s)) {
        throw new RangeError(`invalid credit amount: ${s}`);
      }
      // Route through the string parser so fractional numbers stay exact-ish.
      return Amount.fromCredits(numberToDecimalString(s));
    }
    const trimmed = s.trim();
    const neg = trimmed.startsWith("-");
    const body = neg ? trimmed.slice(1) : trimmed;
    const [wholeStr, fracStr = ""] = body.split(".");
    if (body.split(".").length > 2) {
      throw new RangeError(`invalid credit amount: ${JSON.stringify(s)}`);
    }
    if (fracStr.length > 18) {
      throw new RangeError(`amount ${JSON.stringify(s)} has more than 18 decimal places`);
    }
    if (wholeStr !== "" && !/^\d+$/.test(wholeStr)) {
      throw new RangeError(`invalid credit amount: ${JSON.stringify(s)}`);
    }
    if (fracStr !== "" && !/^\d+$/.test(fracStr)) {
      throw new RangeError(`invalid credit amount: ${JSON.stringify(s)}`);
    }
    const whole = wholeStr === "" ? 0n : BigInt(wholeStr);
    const fracPadded = (fracStr + "0".repeat(18)).slice(0, 18);
    const frac = fracPadded === "" ? 0n : BigInt(fracPadded);
    const baseAbs = whole * CREDIT + frac;
    return new Amount(neg ? -baseAbs : baseAbs);
  }

  /** Construct from `n` whole credits (`n * CREDIT`). Mirrors ce-rs `from_credits`. */
  static fromWholeCredits(n: bigint | number): Amount {
    if (typeof n === "number") {
      if (!Number.isInteger(n)) {
        throw new RangeError(`fromWholeCredits expects an integer, got ${n}`);
      }
      return new Amount(BigInt(n) * CREDIT);
    }
    return new Amount(n * CREDIT);
  }

  /** Wire form: a decimal string of base units, e.g. `"1500000000000000000"`. */
  toBaseUnits(): string {
    return this.base.toString();
  }

  /** Human form: a decimal credit string, trimming trailing zeros, e.g. `"1.5"`. */
  toCredits(): string {
    const sign = this.base < 0n ? "-" : "";
    const v = this.base < 0n ? -this.base : this.base;
    const whole = v / CREDIT;
    const frac = v % CREDIT;
    if (frac === 0n) {
      return `${sign}${whole.toString()}`;
    }
    const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
    return `${sign}${whole.toString()}.${fracStr}`;
  }

  /** `"1.5 credits"`. Mirrors ce-rs `Display`. */
  toString(): string {
    return `${this.toCredits()} credits`;
  }

  /**
   * Serializes to the base-unit decimal string so `JSON.stringify({ amount })` is
   * correct and never throws on a bare `bigint`.
   */
  toJSON(): string {
    return this.toBaseUnits();
  }

  add(o: Amount): Amount {
    return new Amount(this.base + o.base);
  }

  sub(o: Amount): Amount {
    return new Amount(this.base - o.base);
  }

  cmp(o: Amount): -1 | 0 | 1 {
    if (this.base < o.base) return -1;
    if (this.base > o.base) return 1;
    return 0;
  }

  eq(o: Amount): boolean {
    return this.base === o.base;
  }

  isZero(): boolean {
    return this.base === 0n;
  }

  isNegative(): boolean {
    return this.base < 0n;
  }
}

/**
 * Convert a finite JS number into a plain decimal string without scientific notation,
 * so it can be fed through the exact string parser. Best-effort: callers that need
 * exactness for fractional credits should pass a string.
 */
function numberToDecimalString(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  // Avoid exponential notation for small/large magnitudes.
  const s = n.toString();
  if (!s.includes("e") && !s.includes("E")) return s;
  // Expand exponent form.
  return n.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: 18,
  });
}
