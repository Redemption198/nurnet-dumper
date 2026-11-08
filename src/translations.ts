// The translations of the site descriptions, kept in translations/<lang>.json (committed) and
// keyed by a hash of the Italian: a data refresh only translates what is new or changed.
//
// A run with the local model fills in what is missing; a run with a hosted model (OpenRouter)
// redoes all the local translations, the failed ones first. A translation fixed by hand gets
// `"engine": "human"` and is never replaced.

import { createHash } from "node:crypto";

export type Engine = "local" | "hosted" | "human";

export interface CachedTranslation {
  text: string;
  engine: Engine;
  model: string;
  // Whether it passed the checks (translate.ts): only these reach the app
  ok: boolean;
  problems?: string[];
  date: string;
}

export type Cache = Record<string, CachedTranslation>;

const RANK: Record<Engine, number> = { local: 0, hosted: 1, human: 2 };

export const hashOf = (italian: string) =>
  createHash("sha256").update(italian).digest("hex").slice(0, 16);

// Whether a new translation takes the place of the one in the cache
export function replaces(candidate: CachedTranslation, current: CachedTranslation | undefined) {
  if (!current) return true;
  if (current.engine === "human") return false;
  // A translation that passes the checks beats one that doesn't, whatever made them
  if (candidate.ok !== current.ok) return candidate.ok;
  return RANK[candidate.engine] >= RANK[current.engine];
}

export interface Description {
  hash: string;
  text: string;
}

// What a run translates, in order. The local model: what has no translation yet (at temperature 0
// it would only repeat a failed one). A hosted model: every local translation, those that failed
// the checks first, then the longest (where a small model's word-for-word phrasing shows most);
// never what a hosted model or a person already did
export function queue(descriptions: Description[], cache: Cache, engine: "local" | "hosted") {
  const missing = descriptions.filter(({ hash }) => !cache[hash]);
  if (engine === "local") return missing;
  const local = descriptions.filter(({ hash }) => cache[hash]?.engine === "local");
  const failed = local.filter(({ hash }) => !cache[hash]!.ok);
  const passed = local
    .filter(({ hash }) => cache[hash]!.ok)
    .sort((a, b) => b.text.length - a.text.length);
  return [...missing, ...failed, ...passed];
}
