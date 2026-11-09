// Translating the site descriptions through any OpenAI-compatible server: a local model
// (mlx_lm.server, Ollama, LM Studio), or a hosted one (OpenRouter). Only the census's own public
// text is sent. Each translation is checked: one that fails the checks is not used, and the site
// keeps its Italian description

import { spawn } from "node:child_process";

export interface Language {
  code: string;
  // As the prompt names it: "English"
  name: string;
  // Census terms and how this language's archaeology writes them; proper names are never translated
  glossary: [italian: string, translated: string][];
  // Terms that stay as they are: if the Italian has one, the translation must have it too
  kept: RegExp[];
  // How this language writes: word order, numbers, spelling
  style: string[];
  // Census descriptions translated by hand (not in the comparison's sample), shown to the model
  // as earlier turns: a small model copies the style of an example better than it follows a rule
  examples: [italian: string, translated: string][];
}

export const LANGUAGES: Record<string, Language> = {
  en: {
    code: "en",
    name: "English",
    // No examples in brackets: a small model copied them into the text, "single-tower
    // (single-tower) nuraghe"
    glossary: [
      ["nuraghe, nuraghi", "nuraghe, nuraghi; never 'nuraghes'"],
      ["nuragico, prenuragico", "Nuragic, pre-Nuragic"],
      ["domus de janas", "domus de janas"],
      ["tomba di giganti, tomba dei giganti", "giants' tomb"],
      ["nuraghe complesso", "complex nuraghe"],
      ["protonuraghe, nuraghe a corridoio", "proto-nuraghe, corridor nuraghe"],
      // Not a corridor nuraghe: the other type, with a corbelled dome (Qwen confused the two)
      ["nuraghe a tholos", "tholos nuraghe"],
      ["monotorre", "single-tower"],
      ["nuraghe monotorre", "single-tower nuraghe"],
      ["mastio", "central tower"],
      ["svettato", "with its top missing"],
      ["quadrilobato", "four-lobed"],
      ["cortina muraria", "curtain wall"],
      ["paramento murario", "wall face"],
      ["percorso murario, percorso perimetrale", "outline of the walls, perimeter"],
      ["tholos", "tholos"],
      ["betilo, betili", "baetyl, baetyls"],
      ["ortostati", "orthostats"],
      ["esedra", "exedra"],
      ["peristalite", "peristalith"],
      ["stele", "stele"],
      ["a stele centinata", "with an arched stele"],
      ["a filari", "coursed"],
      ["tomba di giganti a filari", "coursed giants' tomb"],
      ["dolmenica", "dolmenic"],
      ["concio a dentelli", "dentilled ashlar"],
      ["protome taurina", "bull's-head protome"],
      ["ovile", "sheepfold"],
      ["architrave", "lintel"],
      ["filari", "courses"],
      ["conci", "ashlars"],
      ["opera isodoma", "isodomic masonry"],
      ["pozzo sacro", "sacred well"],
      ["bastione", "bastion"],
      ["antemurale", "outer wall"],
      ["menhir, dolmen, allée couverte", "menhir, dolmen, allée couverte"],
    ],
    kept: [/nurag/i, /domus de janas/i, /tholos/i, /menhir/i, /dolmen/i],
    style: [
      'Write natural, fluent English, as an archaeologist writing a guidebook would: reorder words and split or join clauses as English needs (not "Of the monument remains only…" but "Only … of the monument remains"), keeping every fact.',
      'Numbers the English way: a decimal point, not a comma ("2,55 m" → "2.55 m", "39,61237 N" → "39.61237 N"); "ca." and "circa" → "about".',
      'British spelling: "metres", "centre".',
    ],
    examples: [
      [
        "Capanna nuragica. Si presenta di forma circolare, realizzata con pietre piatte di varie dimensioni, sovrapposte l'una all'altra in filari aggettanti verso il centro. Il muro ha forma conica: alla base ha una larghezza di 150 cm ca., al vertice una larghezza di 70 cm ca e un'altezza residua di 130 cm ca. Il muro si interrompe per circa 100 cm nella parte sud est (forse l'ingresso), per un crollo della struttura, probabilmente causata da alberi di olivastro e lentisco.",
        "Nuragic hut. It is circular, built of flat stones of various sizes laid one on another in courses that corbel inwards towards the centre. The wall is conical: about 150 cm wide at the base and about 70 cm wide at the top, with a surviving height of about 130 cm. To the south-east the wall breaks off for about 100 cm (perhaps the entrance) where the structure has collapsed, probably because of wild olive and mastic trees.",
      ],
      [
        "Il dolmen è costituito da una serie di massi squadrati e lastroni semilavorati disposti verticalmente in modo tale da creare una camera a pianta rettangolare della lunghezza di circa sei metri. Al di sopra, ad un'altezza di circa 2 metri e 20 altri due lastroni poggiati a piattabanda chiudono il vano funerario; uno dei due lastroni, tra i manufatti dello stesso genere, è per dimensioni il secondo in tutto il bacino del Mediterraneo: misura 4,80 x 3,42 m e ha uno spessore di circa 45 cm.",
        "The dolmen is made of a row of squared boulders and roughly worked slabs set upright to form a rectangular chamber about six metres long. Above it, at a height of about 2.20 metres, two more slabs laid flat close the burial chamber; one of them is the second largest of its kind in the whole Mediterranean basin: it measures 4.80 x 3.42 m and is about 45 cm thick.",
      ],
    ],
  },
};

const termList = (language: Language) =>
  language.glossary.map(([it, tr]) => `- ${it} → ${tr}`).join("\n");
const styleList = (language: Language) => language.style.map((line) => `- ${line}`).join("\n");

export function translationPrompt(language: Language) {
  return `You translate descriptions of archaeological sites in Sardinia, from the NurNet census, from Italian into ${language.name}.

Rules:
- Translate the whole text faithfully, adding and leaving out nothing.
${styleList(language)}
- Answer with the translation only: no title, no notes, no quotation marks, no Markdown.
- Keep the paragraphs: a blank line exactly where the original has one.
- Never translate proper names: sites, places, people, Sardinian names (Su Nuraxi, Sa Domu 'e s'Orku, Is Paras, Monte Prama...).
- Sardinian words and anything in quotation marks stay exactly as written, letter for letter ("nieddu" stays "nieddu").
- Translate what each sentence says: never replace a phrase with the site's type or name ("Sepoltura di epoca nuragica" is "A burial of the Nuragic period", not "Giants' tomb").
- "ben" before a number stresses it: "ben tre nicchie" is "as many as three niches".
- If a word in the original is cut off or garbled, translate it as best you can; do not invent what is missing.
- Use these terms:
${termList(language)}`;
}

export interface Translation {
  text: string;
  seconds: number;
  tokens: number;
  // Empty when the translation can be used
  problems: string[];
}

// Common Italian words: many of them in the result means part of it was left untranslated
const ITALIAN_WORDS = new Set(
  "il lo gli della delle dei degli nel nella nei sono che una uno questo questa dove anche come".split(
    " ",
  ),
);

// The chat template's own tokens ("<|im_end|>", "<end_of_turn>"), which some servers let through
const SPECIAL_TOKEN = /<\|[\w-]+\|>|<\/?(?:start_of_turn|end_of_turn|eos|bos)>/;
const TRAILING_END = /\s*(?:<\|(?:im_end|endoftext|eot_id)\|>|<end_of_turn>|<eos>)\s*$/;

// An end-of-turn token at the very end is harmless: dropped. Anywhere else it's a problem
export const cleanOutput = (text: string) => text.replace(TRAILING_END, "").trim();

export function translationProblems(
  italian: string,
  translated: string,
  language: Language,
  truncated = false,
) {
  const problems: string[] = [];
  if (truncated) problems.push("cut off");
  if (!translated.trim()) return [...problems, "empty"];
  if (translated.trim() === italian.trim()) problems.push("not translated");
  // The Italian's paragraphs, though a break that comes mid-sentence ("…a NO del Nuraghe⏎⏎Su
  // Figu") is the source's own mistake: the translation may join it
  const chunks = italian.split(/\n\s*\n/);
  const fewest =
    1 + chunks.slice(0, -1).filter((chunk) => /[.!?:;"'»”)\]…]\s*$/.test(chunk)).length;
  const count = translated.split(/\n\s*\n/).length;
  if (count < fewest || count > chunks.length)
    problems.push(`paragraphs ${chunks.length} → ${count}`);
  const ratio = translated.length / italian.length;
  if (italian.length > 80 && (ratio < 0.6 || ratio > 1.6))
    problems.push(`length ×${ratio.toFixed(2)}`);
  // A chat opening ("Here is the translation:", "Sure, …"), not a sentence that starts that way
  // ("Certamente un nuraghe…" is "Certainly a nuraghe…"); or the whole answer in quotation marks
  // where the Italian isn't (a description may well start with a quoted name)
  const wrapped = (text: string) => /^\s*["“«][\s\S]*["”»][.)]?\s*$/.test(text);
  if (
    /^\s*(?:here(?:'s| is| are)\b|(?:sure|certainly|of course)\s*[!,:.]|translation\s*:)|^\s*(?:#|\*\*)/i.test(
      translated,
    ) ||
    (wrapped(translated) && !wrapped(italian))
  )
    problems.push("preamble or markup");
  if (/\b(note|translator's note|n\.d\.t)\b\s*:/i.test(translated)) problems.push("added note");
  if (SPECIAL_TOKEN.test(translated)) problems.push("model token");
  // A glossary example copied into the text: "single-tower (single-tower) nuraghe"
  if (/(?:^|[^\p{L}])([\p{L}'-]+) \(\1(?![\p{L}])[^)]*\)/iu.test(translated))
    problems.push("repeated in brackets");
  for (const term of language.kept)
    if (term.test(italian) && !term.test(translated)) problems.push(`lost "${term.source}"`);
  // Quoted titles and names stay Italian ("L'arte delle domus de janas")
  const unquoted = translated.replace(/["“«][^"”»\n]*["”»]/g, " ");
  const words = unquoted.toLowerCase().match(/\p{L}+/gu) ?? [];
  const italianShare = words.filter((word) => ITALIAN_WORDS.has(word)).length / words.length;
  if (words.length > 10 && italianShare > 0.04) problems.push("Italian left");
  return problems;
}

export interface Server {
  endpoint: string;
  model: string;
  // For a hosted service such as OpenRouter ("https://openrouter.ai/api"); a local server has none
  apiKey?: string;
}

type Message = { role: "system" | "user" | "assistant"; content: string };

const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// One answer at temperature 0 (the same text gives the same translation), with room for one a
// good deal longer than the original (~3.5 characters a token)
async function chat({ endpoint, model, apiKey }: Server, messages: Message[], length: number) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: Math.max(256, Math.ceil(length / 2)),
        messages,
        // On a hosted service, models that reason by default (Nemotron) would spend the whole
        // token allowance thinking and answer nothing: a translation needs no reasoning
        ...(apiKey && { reasoning: { effort: "none" } }),
      }),
      signal: AbortSignal.timeout(600_000),
    }).catch((error: unknown) => {
      if (attempt < 8) return null;
      throw error;
    });
    // A dropped connection, a rate limit (OpenRouter's free models: 20 a minute, and a pool
    // shared with every user upstream) or a busy provider: wait, longer each time, and try again
    if (!response || ((response.status === 429 || response.status >= 500) && attempt < 8)) {
      await sleep(Number(response?.headers.get("retry-after")) || Math.min(20 * attempt, 120));
      continue;
    }
    if (!response.ok)
      throw new Error(`${endpoint}: HTTP ${response.status} ${await response.text()}`);
    type Reply = {
      choices?: { message: { content: string | null }; finish_reason: string }[];
      usage?: { completion_tokens?: number };
      error?: { message?: string };
    };
    // The connection can also drop while the answer is coming ("terminated"): the same wait
    const data = (await response.json().catch((error: unknown) => {
      if (attempt < 8) return null;
      throw error;
    })) as Reply | null;
    if (!data) {
      await sleep(Math.min(20 * attempt, 120));
      continue;
    }
    // OpenRouter reports some failures (a provider down) inside a 200 reply
    const choice = data.choices?.[0];
    if (!choice) throw new Error(`${endpoint}: ${data.error?.message ?? "no answer"}`);
    return {
      text: cleanOutput(choice.message.content ?? ""),
      tokens: data.usage?.completion_tokens ?? 0,
      truncated: choice.finish_reason === "length",
    };
  }
}

// One description. A second pass that reviews the first was tried on the sample: twice the time,
// and it brought in as many mistakes as it fixed
export async function translate(
  italian: string,
  language: Language,
  server: Server,
): Promise<Translation> {
  const started = performance.now();
  const examples = language.examples.flatMap(([it, tr]): Message[] => [
    { role: "user", content: it },
    { role: "assistant", content: tr },
  ]);
  const result = await chat(
    server,
    [
      { role: "system", content: translationPrompt(language) },
      ...examples,
      { role: "user", content: italian },
    ],
    italian.length,
  );
  return {
    text: result.text,
    seconds: (performance.now() - started) / 1000,
    tokens: result.tokens,
    problems: translationProblems(italian, result.text, language, result.truncated),
  };
}

// Starts mlx_lm.server (`command`) with `model` and waits until it answers; the first time, it
// downloads the model. The model loads on the first request, made here so it isn't timed
export async function startLocalServer(
  command: string,
  model: string,
  port: string,
  language: Language,
) {
  const server = spawn(command, ["--model", model, "--port", port], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  let exited = false;
  server.once("exit", () => (exited = true));
  const target: Server = { endpoint: `http://127.0.0.1:${port}`, model };
  try {
    for (const started = Date.now(); ;) {
      if (exited) throw new Error(`${command} exited`);
      if (Date.now() - started > 60 * 60_000) throw new Error(`${command} didn't start in an hour`);
      const ready = await fetch(`${target.endpoint}/v1/models`).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) break;
      await sleep(3);
    }
    await translate("Nuraghe monotorre.", language, target).catch(async () =>
      translate("Nuraghe monotorre.", language, target),
    );
  } catch (error) {
    server.kill();
    throw error;
  }
  return { target, stop: () => server.kill() };
}

// Waits so that calls are at least `seconds` apart: a hosted service's rate limit
export function pacer(seconds: number) {
  let last = 0;
  return async () => {
    const wait = last + seconds * 1000 - Date.now();
    if (wait > 0) await sleep(wait / 1000);
    last = Date.now();
  };
}
