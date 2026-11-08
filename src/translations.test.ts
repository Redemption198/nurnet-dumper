import { describe, expect, it } from "vite-plus/test";
import { type CachedTranslation, queue, replaces } from "./translations.ts";

const entry = (engine: CachedTranslation["engine"], ok = true): CachedTranslation => ({
  text: "…",
  engine,
  model: "m",
  ok,
  date: "2026-11-08",
});

describe("replaces", () => {
  it("fills what is missing, and upgrades local to hosted", () => {
    expect(replaces(entry("local"), undefined)).toBe(true);
    expect(replaces(entry("hosted"), entry("local"))).toBe(true);
    expect(replaces(entry("local"), entry("hosted"))).toBe(false);
  });

  it("never replaces a hand fix", () => {
    expect(replaces(entry("hosted"), entry("human"))).toBe(false);
  });

  it("keeps a passing translation over a failing one, whatever made them", () => {
    expect(replaces(entry("hosted", false), entry("local", true))).toBe(false);
    expect(replaces(entry("local", true), entry("hosted", false))).toBe(true);
  });
});

describe("queue", () => {
  const descriptions = [
    { hash: "a", text: "short" },
    { hash: "b", text: "a longer description" },
    { hash: "c", text: "failed" },
    { hash: "d", text: "missing" },
    { hash: "e", text: "done by a hosted model" },
    { hash: "f", text: "fixed by hand" },
  ];
  const cache = {
    a: entry("local"),
    b: entry("local"),
    c: entry("local", false),
    e: entry("hosted"),
    f: entry("human"),
  };

  it("gives the local model only what has no translation", () => {
    expect(queue(descriptions, cache, "local").map((d) => d.hash)).toEqual(["d"]);
  });

  it("gives a hosted model every local one: the missing, the failed, then the longest", () => {
    expect(queue(descriptions, cache, "hosted").map((d) => d.hash)).toEqual(["d", "c", "b", "a"]);
  });
});
