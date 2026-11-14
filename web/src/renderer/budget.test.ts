import { describe, expect, test } from "vitest";
import { ByteBudget } from "./budget";

describe("CPU byte budget", () => {
  test("evicts the least recently used entry", () => {
    const budget = new ByteBudget<number>(10);
    budget.set("a", 1, 6);
    budget.set("b", 2, 4);
    expect(budget.get("a")).toBe(1);
    budget.set("c", 3, 4);
    expect(budget.get("b")).toBeUndefined();
    expect(budget.byteLength).toBe(10);
    budget.clear();
    expect(budget.byteLength).toBe(0);
  });

  test("rejects an individually over-budget entry", () =>
    expect(() => new ByteBudget(4).set("x", true, 5)).toThrow(RangeError));

  test("pins displayed data against candidate cache pressure", () => {
    const cache = new ByteBudget<string>(10);
    cache.set("displayed", "old", 6);
    cache.pin("displayed");
    cache.set("candidate", "new", 6);
    expect(cache.get("displayed")).toBe("old");
    expect(cache.get("candidate")).toBeUndefined();
    cache.unpin("displayed");
    cache.set("candidate", "new", 6);
    expect(cache.get("candidate")).toBe("new");
  });
});
