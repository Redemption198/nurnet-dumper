// Translates the site descriptions into one language and writes the file the app downloads when a
// visitor uses that language: out/nurnet-descriptions.<lang>.json, to copy to the app's public/
// with the other data files. The translations are kept in translations/<lang>.json
// (translations.ts), saved after each one: a run can stop at any point and the next goes on.
//
// A free model on OpenRouter, the daily quota at a time: the descriptions with no translation yet,
// then the local model's ones, those that failed the checks first (the key in OPENROUTER_API_KEY;
// OpenRouter's free models allow 1000 requests a day):
//
//   vpx src/translate-run.ts [--lang en] [--limit 1000]
//
// Or the local model, nothing leaving the machine (mlx_lm 0.32 or later):
//
//   vpx src/translate-run.ts --engine local [--lang en]
//
// A translation fixed by hand in translations/<lang>.json gets "engine": "human" and is kept.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  LANGUAGES,
  pacer,
  type Server,
  startLocalServer,
  translate,
  translationProblems,
} from "./translate.ts";
import {
  type Cache,
  type CachedTranslation,
  type Description,
  hashOf,
  queue,
  replaces,
} from "./translations.ts";

const { values: args } = parseArgs({
  options: {
    lang: { type: "string", default: "en" },
    engine: { type: "string", default: "hosted" },
    model: { type: "string" },
    // At most this many translations in this run (a hosted model: its daily quota)
    limit: { type: "string" },
    base: { type: "string", default: "../nurnet-plus/public" },
    out: { type: "string", default: "out" },
    cache: { type: "string", default: "translations" },
    // The local model's server (mlx_lm 0.32 or later)
    server: { type: "string", default: "mlx_lm.server" },
    port: { type: "string", default: "8089" },
    // The hosted model's service: one request every --pace seconds
    endpoint: { type: "string", default: "https://openrouter.ai/api" },
    pace: { type: "string", default: "3.2" },
  },
});

const language = LANGUAGES[args.lang];
if (!language) throw new Error(`No language "${args.lang}" in translate.ts`);
const engine = args.engine;
if (engine !== "local" && engine !== "hosted") throw new Error("--engine is local or hosted");
const model =
  args.model ??
  (engine === "local"
    ? "mlx-community/Qwen3-4B-Instruct-2507-4bit"
    : "nvidia/nemotron-3-ultra-550b-a55b:free");
const apiKey = process.env.OPENROUTER_API_KEY;
if (engine === "hosted" && !apiKey)
  throw new Error("Set OPENROUTER_API_KEY, or use --engine local");

const details = JSON.parse(await readFile(`${args.base}/nurnet-details.json`, "utf8")) as {
  sites: Record<string, { description?: string }>;
};

// Each description once (some sites share one), and the sites that have it
const sitesOf = new Map<string, string[]>();
const descriptions: Description[] = [];
for (const [id, site] of Object.entries(details.sites)) {
  if (!site.description) continue;
  const hash = hashOf(site.description);
  if (!sitesOf.has(hash)) {
    sitesOf.set(hash, []);
    descriptions.push({ hash, text: site.description });
  }
  sitesOf.get(hash)!.push(id);
}

const cacheFile = `${args.cache}/${language.code}.json`;
const cache = (await readFile(cacheFile, "utf8").then(JSON.parse, () => ({}))) as Cache;
// Checked again with today's checks, which may be newer than the translations; not a person's
for (const { hash, text } of descriptions) {
  const entry = cache[hash];
  if (!entry || entry.engine === "human") continue;
  const cutOff = entry.problems?.includes("cut off");
  const problems = translationProblems(text, entry.text, language, cutOff);
  entry.ok = problems.length === 0;
  if (problems.length) entry.problems = problems;
  else delete entry.problems;
}
// Sorted by hash, so the committed file changes only where a translation did
const saveCache = () =>
  writeFile(
    cacheFile,
    `${JSON.stringify(Object.fromEntries(Object.entries(cache).sort(([a], [b]) => (a < b ? -1 : 1))), null, 1)}\n`,
  );
await mkdir(args.cache, { recursive: true });
await saveCache();

// A hosted model: OpenRouter's daily quota for free models, unless told otherwise
const limit = Number(args.limit ?? (engine === "hosted" ? 1000 : Infinity));
const todo = queue(descriptions, cache, engine).slice(0, limit);
console.log(
  `${descriptions.length} descriptions, ${todo.length} to translate with ${model} (${engine})`,
);

let target: Server = { endpoint: args.endpoint, model, apiKey };
let stop = () => {};
if (todo.length && engine === "local") {
  console.log("Starting the local server (the first time, it downloads the model)…");
  ({ target, stop } = await startLocalServer(args.server, model, args.port, language));
}

const pace = pacer(engine === "hosted" ? Number(args.pace) : 0);
const started = Date.now();
const counts = { replaced: 0, kept: 0, failed: 0 };
try {
  for (const [i, { hash, text }] of todo.entries()) {
    await pace();
    let result;
    try {
      result = await translate(text, language, target);
    } catch (error) {
      // Out of retries: the service is down or the day's quota is used up. What's done is saved
      console.error(`Stopped: ${String(error).slice(0, 300)}`);
      break;
    }
    const candidate: CachedTranslation = {
      text: result.text,
      engine,
      model,
      ok: result.problems.length === 0,
      ...(result.problems.length && { problems: result.problems }),
      date: new Date().toISOString().slice(0, 10),
    };
    if (!candidate.ok) counts.failed++;
    if (replaces(candidate, cache[hash])) {
      cache[hash] = candidate;
      counts.replaced++;
      await saveCache();
    } else counts.kept++;
    const left = ((Date.now() - started) / (i + 1)) * (todo.length - i - 1);
    const flags = candidate.ok ? "" : `  ⚠ ${result.problems.join(", ")}`;
    console.log(
      `  ${i + 1}/${todo.length} ${sitesOf.get(hash)![0]} ${result.seconds.toFixed(1)}s, ~${Math.round(left / 60_000)} min left${flags}`,
    );
  }
} finally {
  stop();
}

// The app's file: each site's translated description, where one passed the checks
const translated: Record<string, string> = {};
for (const { hash } of descriptions) {
  const entry = cache[hash];
  if (entry?.ok) for (const id of sitesOf.get(hash)!) translated[id] = entry.text;
}
await mkdir(args.out, { recursive: true });
const outFile = `${args.out}/nurnet-descriptions.${language.code}.json`;
await writeFile(
  outFile,
  JSON.stringify({ generated: new Date().toISOString(), descriptions: translated }),
);

const byEngine: Record<string, number> = {};
for (const { hash } of descriptions)
  if (cache[hash]?.ok) byEngine[cache[hash]!.engine] = (byEngine[cache[hash]!.engine] ?? 0) + 1;
const ready = Object.values(byEngine).reduce((sum, n) => sum + n, 0);
console.log(
  `\nThis run: ${counts.replaced} saved, ${counts.kept} kept the earlier translation, ${counts.failed} failed the checks`,
);
console.log(
  `Translated: ${ready} of ${descriptions.length} descriptions (${Object.entries(byEngine)
    .map(([name, n]) => `${name} ${n}`)
    .join(", ")}); the rest stay in Italian`,
);
console.log(`Wrote ${outFile} (${Object.keys(translated).length} sites)`);
