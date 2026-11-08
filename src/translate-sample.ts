// Compares local models, or prompts, on the same sample of descriptions, before translating them
// all. Starts mlx_lm.server for each model in turn (downloading it the first time), saves each run
// as <label>.json, and writes out/translate-sample/compare.html: the Italian and every saved run
// on this sample side by side, the checks that failed, the speed and what a full run would take.
//
//   vpx src/translate-sample.ts [--models a,b] [--label name] [--count 50] [--lang en]
//
// With --endpoint, the models run on that OpenAI-compatible service instead, with the key in
// OPENROUTER_API_KEY, one request every --pace seconds (OpenRouter's free models allow 20 a
// minute and 1000 a day):
//
//   vpx src/translate-sample.ts --endpoint https://openrouter.ai/api --models google/gemma-4-31b-it:free

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  cleanOutput,
  LANGUAGES,
  pacer,
  startLocalServer,
  translate,
  translationProblems,
  type Server,
  type Translation,
} from "./translate.ts";

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "../nurnet-plus/public" },
    out: { type: "string", default: "out/translate-sample" },
    models: {
      type: "string",
      default: "mlx-community/Qwen3-4B-Instruct-2507-4bit,mlx-community/gemma-3-4b-it-qat-4bit",
    },
    count: { type: "string", default: "50" },
    lang: { type: "string", default: "en" },
    server: { type: "string", default: "mlx_lm.server" },
    port: { type: "string", default: "8089" },
    // The run's name on the page and in its file (one model only); the model's name by default
    label: { type: "string" },
    endpoint: { type: "string" },
    pace: { type: "string", default: "3.2" },
  },
});

const language = LANGUAGES[args.lang];
if (!language) throw new Error(`No language "${args.lang}" in translate.ts`);
const models = args.models.split(",").filter(Boolean);
if (args.label && models.length > 1) throw new Error("--label names the run of one model");
const labelOf = (model: string) => args.label ?? model.split("/").at(-1)!;
const apiKey = process.env.OPENROUTER_API_KEY;
if (args.endpoint && !apiKey) throw new Error("--endpoint needs the key in OPENROUTER_API_KEY");

const details = JSON.parse(await readFile(`${args.base}/nurnet-details.json`, "utf8")) as {
  sites: Record<string, { description?: string }>;
};

// Each description once (some sites share one), with the first site that has it
const descriptions = new Map<string, string>();
for (const [id, site] of Object.entries(details.sites))
  if (site.description && !descriptions.has(site.description))
    descriptions.set(site.description, id);
const all = [...descriptions].map(([text, id]) => ({ id, text }));
const allCharacters = all.reduce((sum, { text }) => sum + text.length, 0);

// The hard cases first: a damaged text, the census's technical terms, several paragraphs, the
// longest; then descriptions spread evenly over the lengths
function pickSample(count: number) {
  const picked = new Map<string, { id: string; text: string }>();
  const add = (item?: { id: string; text: string }) => item && picked.set(item.id, item);
  add(all.find(({ id }) => id === "NUR12187"));
  for (const pattern of [/betil/i, /ortostat/i, /tholos/i, /esedr/i, /isodom/i, /mastio/i])
    add(all.find(({ text }) => pattern.test(text)));
  add(all.find(({ text }) => text.split("\n\n").length >= 4));
  const byLength = [...all].sort((a, b) => a.text.length - b.text.length || (a.id < b.id ? -1 : 1));
  add(byLength.at(-1));
  const rest = byLength.filter(({ id }) => !picked.has(id));
  const needed = count - picked.size;
  for (let i = 0; i < needed; i++) add(rest[Math.floor(((i + 0.5) * rest.length) / needed)]);
  return [...picked.values()];
}

const sample = pickSample(Number(args.count));
const sampleCharacters = sample.reduce((sum, { text }) => sum + text.length, 0);
console.log(
  `${sample.length} descriptions (${sampleCharacters} characters) of ${all.length} (${allCharacters})`,
);

interface ModelRun {
  model: string;
  label?: string;
  results: (Translation & { id: string })[];
}

await mkdir(args.out, { recursive: true });
const fileOf = (label: string) => `${args.out}/${label.replace(/[^\w.-]+/g, "_")}.json`;
const sameSample = (run: ModelRun | null) =>
  run?.results.map((r) => r.id).join() === sample.map((s) => s.id).join();

for (const model of models) {
  // A run already saved on this same sample isn't run again: delete its file to redo it
  const file = fileOf(labelOf(model));
  const saved = (await readFile(file, "utf8").then(JSON.parse, () => null)) as ModelRun | null;
  if (sameSample(saved)) {
    console.log(`\n${labelOf(model)}: already run on this sample (${file})`);
    continue;
  }
  let target: Server;
  let stop = () => {};
  if (args.endpoint) {
    console.log(`\n${model}: on ${args.endpoint}`);
    target = { endpoint: args.endpoint, model, apiKey };
  } else {
    console.log(`\n${model}: starting the server (the first time, it downloads the model)…`);
    ({ target, stop } = await startLocalServer(args.server, model, args.port, language));
  }
  try {
    const run: ModelRun = { model, label: labelOf(model), results: [] };
    const pace = pacer(args.endpoint ? Number(args.pace) : 0);
    for (const [i, { id, text }] of sample.entries()) {
      await pace();
      const result = await translate(text, language, target);
      run.results.push({ id, ...result });
      const flags = result.problems.length ? `  ⚠ ${result.problems.join(", ")}` : "";
      console.log(`  ${i + 1}/${sample.length} ${id} ${result.seconds.toFixed(1)}s${flags}`);
    }
    await writeFile(file, JSON.stringify(run, null, 1));
  } finally {
    stop();
  }
}

// Every saved run on this sample, by file name, checked again with today's checks (which may be
// newer than the run)
const runs: ModelRun[] = [];
for (const name of (await readdir(args.out)).filter((n) => n.endsWith(".json")).sort()) {
  const run = JSON.parse(await readFile(`${args.out}/${name}`, "utf8")) as ModelRun;
  if (!sameSample(run)) continue;
  const results = run.results.map((r, i) => {
    const text = cleanOutput(r.text);
    const cutOff = r.problems.includes("cut off");
    return { ...r, text, problems: translationProblems(sample[i]!.text, text, language, cutOff) };
  });
  runs.push({ ...run, label: run.label ?? name.replace(/\.json$/, ""), results });
}

// --- The comparison page ---

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const paragraphs = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((p) => `<p>${escape(p)}</p>`)
    .join("");

function summary({ label, results }: ModelRun) {
  const seconds = results.reduce((sum, r) => sum + r.seconds, 0);
  const tokens = results.reduce((sum, r) => sum + r.tokens, 0);
  const flagged = results.filter((r) => r.problems.length).length;
  const fullHours = ((seconds / sampleCharacters) * allCharacters) / 3600;
  return `<tr><th>${escape(label!)}</th><td>${flagged} / ${results.length}</td><td>${(tokens / seconds).toFixed(1)}</td><td>${seconds.toFixed(0)} s</td><td>≈ ${fullHours.toFixed(1)} h</td></tr>`;
}

const rows = sample
  .map(({ id, text }, i) => {
    const cells = runs
      .map(({ results }) => {
        const r = results[i]!;
        const tags = r.problems.map((p) => `<span class="flag">${escape(p)}</span>`).join("");
        return `<td>${paragraphs(r.text)}<div class="meta">${r.seconds.toFixed(1)} s${tags}</div></td>`;
      })
      .join("");
    return `<tr><td><div class="id">${id} · ${text.length} chars</div>${paragraphs(text)}</td>${cells}</tr>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Translation sample</title>
<style>
:root { color-scheme: light dark; --bg: #faf7f2; --fg: #2b2622; --muted: #6b625b; --line: #e4ddd3; --flag: #b3412b; --flag-bg: #fbe9e4; }
@media (prefers-color-scheme: dark) { :root { --bg: #1d1a17; --fg: #ece5dc; --muted: #a39588; --line: #3a342e; --flag: #f0a08c; --flag-bg: #43251d; } }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
h1 { font-size: 1.4rem; margin: 0 0 4px; } .lead { color: var(--muted); margin: 0 0 20px; max-width: 70ch; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; vertical-align: top; padding: 10px 12px; border-top: 1px solid var(--line); }
.summary { width: auto; margin-bottom: 28px; } .summary td, .summary th { padding: 6px 14px 6px 0; }
.compare td { width: ${Math.floor(100 / (runs.length + 1))}%; } .compare p { margin: 0 0 8px; }
thead th { position: sticky; top: 0; background: var(--bg); font-size: 0.85rem; }
.id, .meta { color: var(--muted); font-size: 0.8rem; } .id { margin-bottom: 4px; font-weight: 600; }
.flag { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 4px; background: var(--flag-bg); color: var(--flag); font-weight: 600; }
@media (max-width: 700px) { .compare, .compare tbody, .compare tr, .compare td { display: block; width: auto !important; } .compare thead { display: none; } .compare tr { border-top: 2px solid var(--line); } }
</style></head><body>
<h1>Translation sample: Italian → ${escape(language.name)}</h1>
<p class="lead">${sample.length} of ${all.length} descriptions, the hard cases first (a damaged text, technical terms, many paragraphs, the longest), then spread over the lengths. Flags are the automatic checks; a flagged translation would not be used.</p>
<table class="summary"><thead><tr><th>Run</th><th>Flagged</th><th>Tokens/s</th><th>Sample</th><th>Full run</th></tr></thead><tbody>${runs.map(summary).join("")}</tbody></table>
<table class="compare"><thead><tr><th>Italian</th>${runs.map((r) => `<th>${escape(r.label!)}</th>`).join("")}</tr></thead><tbody>
${rows}
</tbody></table></body></html>
`;

await writeFile(`${args.out}/compare.html`, html);
console.log(`\nWrote ${args.out}/compare.html`);
