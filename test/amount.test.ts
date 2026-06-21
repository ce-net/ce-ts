import { describe, it, expect } from "vitest";
import { Amount, CREDIT } from "../src/amount.js";

describe("Amount", () => {
  it("parse/format round-trip matches ce-rs fixtures", () => {
    for (const s of [
      "0",
      "1",
      "1000",
      "1.5",
      "0.25",
      "0.000000000000000001",
      "21000000000",
    ]) {
      expect(Amount.fromCredits(s).toCredits()).toBe(s);
    }
  });

  it("fromWholeCredits and base units", () => {
    expect(Amount.fromWholeCredits(1).toBaseUnits()).toBe(CREDIT.toString());
    expect(Amount.fromWholeCredits(1000).toCredits()).toBe("1000");
    expect(Amount.fromBaseUnits(CREDIT / 2n).toCredits()).toBe("0.5");
  });

  it("rejects too many decimals and garbage", () => {
    expect(() => Amount.fromCredits("0.0000000000000000001")).toThrow();
    expect(() => Amount.fromCredits("xyz")).toThrow();
    expect(() => Amount.fromBaseUnits("1.5")).toThrow();
    expect(() => Amount.fromBaseUnits("abc")).toThrow();
  });

  it("wire form is a base-unit string and toJSON is safe in JSON.stringify", () => {
    const a = Amount.fromWholeCredits(1);
    expect(a.toBaseUnits()).toBe("1000000000000000000");
    expect(JSON.stringify({ amount: a })).toBe('{"amount":"1000000000000000000"}');
    expect(Amount.fromBaseUnits(a.toBaseUnits()).eq(a)).toBe(true);
  });

  it("handles values larger than 2^53 (supply cap) with byte-equality", () => {
    // 21e9 credits = supply cap in base units.
    const cap = Amount.fromWholeCredits(21_000_000_000n);
    const wire = cap.toBaseUnits();
    expect(wire).toBe("21000000000000000000000000000");
    expect(Amount.fromBaseUnits(wire).toBaseUnits()).toBe(wire);
    expect(cap.toCredits()).toBe("21000000000");
  });

  it("arithmetic and comparison", () => {
    const a = Amount.fromCredits("1.5");
    const b = Amount.fromCredits("0.5");
    expect(a.add(b).toCredits()).toBe("2");
    expect(a.sub(b).toCredits()).toBe("1");
    expect(a.cmp(b)).toBe(1);
    expect(b.cmp(a)).toBe(-1);
    expect(a.cmp(a)).toBe(0);
    expect(Amount.ZERO.isZero()).toBe(true);
    expect(Amount.fromBaseUnits("-1").isNegative()).toBe(true);
  });

  it("negative credit parsing/formatting", () => {
    const a = Amount.fromCredits("-1.5");
    expect(a.toBaseUnits()).toBe("-1500000000000000000");
    expect(a.toCredits()).toBe("-1.5");
  });
});
