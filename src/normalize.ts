// Cleanup rules for the NurNet data. Each function is small and safe to run twice.

type Text = string | null | undefined;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** HTML entities as characters ("&amp;" -> "&"), also when encoded twice ("&amp;lt;"). */
export function decodeEntities(value: string): string {
  let previous;
  do {
    previous = value;
    value = value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name[0] === "#") {
        const code =
          name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
      }
      return ENTITIES[name.toLowerCase()] ?? entity;
    });
  } while (value !== previous);
  return value;
}

/**
 * Some descriptions upstream are a whole raw record of the old portal (its XML, from mid-tag:
 * `typecode="NUR" typedescr="…"><descr>…</descr>…<attribute name="Note"…><text lang="en">…</`).
 * The description is the record's note: that is kept, the rest dropped. Other text is unchanged.
 */
export function recoverLeakedRecord(value: Text): string {
  const text = value ?? "";
  if (!/typedescr="|<attributes>|<attribute name="/.test(text)) return text;
  const note = text.match(
    /<attribute name="Note"[^>]*>\s*<text[^>]*>([\s\S]*?)(?:<\/text>|<\/?[a-z]*\s*$)/i,
  );
  return note ? note[1]! : "";
}

/**
 * A missing space after a full stop ("dei tempi.Si accede" -> "dei tempi. Si accede"), only
 * between words: links, e-mails and abbreviations like "S.Antonio" are left alone.
 */
export function spaceSentences(value: string): string {
  return value
    .split(" ")
    .map((word) =>
      /:\/\/|www\.|@/.test(word) ? word : word.replace(/(\p{Ll}{3})\.(\p{Lu}\p{Ll})/gu, "$1. $2"),
    )
    .join(" ");
}

/**
 * UTF-8 that was read as Latin-1 somewhere upstream ("nÂ° VIII" for "n° VIII", "perchÃ¨" for
 * "perché"): decoded back when the whole text is like that, else the common "Â" before a symbol
 * dropped.
 */
export function fixEncoding(value: string): string {
  if (!/Ã[\u0080-\u00bf]|Â[\u00a0-\u00bf]|â€/.test(value)) return value;
  // Only Latin-1 characters: each is one byte of the original UTF-8
  if ([...value].every((c) => c.charCodeAt(0) <= 0xff)) {
    const decoded = new TextDecoder().decode(Uint8Array.from(value, (c) => c.charCodeAt(0)));
    if (!decoded.includes("\ufffd")) return decoded;
  }
  return value.replace(/Â([\u00a0-\u00bf])/g, "$1");
}

// A paragraph that ends mid-sentence, before one that goes on with it (a lowercase word, a
// bracket, a quotation): a line wrapped upstream, not a paragraph
const ENDS_SENTENCE = /[.!?:;"'»)\]…]$/;
const CONTINUES = /^[\p{Ll}("“«]/u;
// A paragraph that can't end there at all: on a comma, an open bracket, or a word that needs
// the next one ("a SE del" / "Nuraghe Arghentu")
const ENDS_OPEN =
  /(?:[,(]|\s(?:a|al|alla|da|dal|dalla|de|dei|del|della|di|e|in|nel|nella|per|sa|su|sul|sulla|tra|fra|verso|con|il|la|lo|le|gli))$/i;

/**
 * Trim, collapse whitespace, decode HTML entities, fix broken encoding, straight apostrophes, fix doubled ones
 * ("Sa Grutta ''e" -> "Sa Grutta 'e"), and drop a stray < or > inside a word ("Su T<empiesu").
 */
export function normalizeText(value: Text): string {
  return fixEncoding(decodeEntities(value ?? ""))
    .replace(/(?<=\p{L})[<>](?=\p{L})/gu, "")
    .replace(/[’‘`´]/g, "'")
    .replace(/'{2,}/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Like normalizeText, but keeps paragraphs (for descriptions). Upstream encodes line breaks as
 * " ; " (a space before a semicolon, which normal punctuation never has): those become paragraphs.
 */
export function normalizeParagraphs(value: Text): string {
  return recoverLeakedRecord(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\s+;(?:\s*;)*\s+/g, "\n\n")
    .split(/\n{2,}/)
    .map((paragraph) => spaceSentences(normalizeText(paragraph)))
    .filter(Boolean)
    .reduce<string[]>((paragraphs, paragraph) => {
      const last = paragraphs.at(-1);
      const wrapped =
        last && ((!ENDS_SENTENCE.test(last) && CONTINUES.test(paragraph)) || ENDS_OPEN.test(last));
      if (wrapped) {
        paragraphs[paragraphs.length - 1] = `${last} ${paragraph}`;
      } else {
        paragraphs.push(paragraph);
      }
      return paragraphs;
    }, [])
    .join("\n\n");
}

export interface Link {
  url: string;
  // What the app shows; without one, the address's host ("aserramanna.it")
  label?: string;
}

// The Merella thesis (Università di Sassari) is cited by an address cut off upstream, on a server
// that's gone since: the thesis is now on the university's IRIS repository
const MERELLA =
  /(?:Per approfondire:\s*)?eprints\.uniss\.it\/9371\/1\/Merella_S_Indagini_territoriali\.{3}(?:\s*(?:pagg?\.|Pagine:)\s*(\d+(?:\s*[-–]\s*\d+)?))?/gi;
const MERELLA_URL =
  "https://iris.uniss.it/retrieve/e1dc1a2c-df72-1507-e053-3a05fe0ac7a3/Merella_S_Indagini_territoriali_sugli_aspetti.pdf";
// A web address written out in full, with its scheme or "www.", and the label before it ("Info:").
// A bare name ("Da Tharros.info.") is part of the sentence and stays
const LABEL = /(?:Info|Link|Sito|Vedi|Fonte):\s*/i;
const ADDRESS = new RegExp(
  `(?:\\b${LABEL.source})?\\b(?:https?:\\/\\/|www\\.)[^\\s<>"“”«»]+`,
  "gi",
);

/**
 * Takes the web addresses out of a description, as links the app shows under it: in the text
 * they're unreadable on a phone, and a machine translation could garble them. A description
 * without one comes back as it is
 */
export function extractLinks(description: string): { text: string; links: Link[] } {
  const links: Link[] = [];
  const add = (link: Link) => {
    if (!links.some(({ url }) => url === link.url)) links.push(link);
  };
  let text = description.replace(MERELLA, (_match, pages?: string) => {
    const range = pages?.replace(/\s*[-–]\s*/, "–");
    const where = range ? `, ${range.includes("–") ? "pp." : "p."} ${range}` : "";
    add({ url: MERELLA_URL, label: `Merella, Indagini territoriali${where}` });
    return "";
  });
  text = text.replace(ADDRESS, (match) => {
    // Only a label ("Info:") goes: "http:" is part of the address
    const address = match.replace(new RegExp(`^${LABEL.source}`, "i"), "");
    // Sentence punctuation after the address stays in the text
    const url = address.replace(/[.,;:)]+$/, "");
    add({ url: /^https?:\/\//i.test(url) ? url : `http://${url}` });
    return address.slice(url.length);
  });
  if (!links.length) return { text: description, links };
  text = text
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\s+([.,;:])/g, "$1")
        .trim(),
    )
    // A label left on its own ("Per approfondire:", "Pagine:")
    .filter((paragraph) => paragraph && !/^[\p{L} ]{1,20}:$/u.test(paragraph))
    .join("\n\n");
  return { text, links };
}

// A source written as a bare address, "sardegnacultura.it" or "www.ilportalesardo.it/archeo/…":
// no spaces, and a domain ending we know, so a name like "G.Lilliu" isn't one
const BARE_ADDRESS =
  /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:it|com|org|net|info|eu|edu|gov|de|fr|uk|es)(?:\/\S*)?$/i;
// Checked on 2026-11-08 (every source address, bare or full): the domain no longer exists, or the
// page was removed (404, 410). Written without scheme, "www." or a final "/", in lowercase.
// Servers that didn't answer from abroad (town and region sites) aren't here: they may well
// answer in Italy
const GONE_HOSTS = new Set([
  "villanovaforru.gov.it",
  "villaubana.net",
  "suscruxoxu.it",
  "oristanosardegna.eu",
  "sardegna.beniculturali.it",
  "portalesardo.it",
  "supramontes.blogspot.com",
  "prolocofonni.it",
  "visitittiri.com",
  "parcoarcheologicosuni.it",
  "progettoiloi.it",
  "castiadasonline.it",
  "coolturistika.it",
  "comune.tratalias.ca.it",
  "scuolasettimo.gov.it",
]);
const GONE_PAGES = new Set([
  "web.tiscali.it/mariobasciudonori/siti_archeologici.htm",
  "comune.ittiri.ss.it/web/pg/eta-nuragica/5",
  "comune.ploaghe.ss.it/pg/nuraghe-don-micheli/66",
  "comune.ploaghe.ss.it/pg/tomba-di-giganti-di-fiorosu/64",
  "comune.settimosanpietro.ca.it/media/files/contenuti/area%20tecnica/08_relazione_archeologica.pdf",
  "giarasardegna.it/it/content/nuraghe-san-marco",
  "comuneaidomaggiore.it/archeologiaa",
  "prolocoarbus.it/proloco-arbus/nuraghe-di-cugui",
  // Cut off upstream, too
  "ojs.unica.it/index.../archeoarte/article/view/510/421",
]);
const GONE_PAGE_HOSTS = new Set([...GONE_PAGES].map((page) => page.split("/")[0]!));

/**
 * A source that is a web address, as the app should show it: a full address to link to (a bare
 * one gets its "http://"), or, where it's gone, just the site's name as text ("Source:
 * comune.ploaghe.ss.it"), which still says where the information came from. A name stays as it is
 */
export function sourceAddress(source: string, { ours = false } = {}): string {
  const full = /^https?:\/\//i.test(source);
  if (!full && !BARE_ADDRESS.test(source)) return source;
  const address = source
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "")
    .toLowerCase();
  const host = address.split("/")[0]!;
  // With CRS4 down the dumper starts from its own output (`ours`), where the bare name of a site
  // whose page is gone is what this returned before: it stays a name. From upstream the same
  // name ("giarasardegna.it") is a working site, linked
  const goneName = ours && !full && address === host && GONE_PAGE_HOSTS.has(host);
  if (GONE_HOSTS.has(host) || GONE_PAGES.has(address) || goneName) return host;
  return full ? source : `http://${source}`;
}

const STATUS_NAMES: Record<string, string> = {
  manutenuto: "Mantenuto",
  mantenuto: "Mantenuto",
  buono: "Buono",
  diroccato: "Diroccato",
  "non visibile": "Non visibile",
  sconosciuto: "Sconosciuto",
  // A previous manual edit truncated "sconosciuto" to "S"
  s: "Sconosciuto",
};

export function normalizeStatus(value: Text): string {
  const status = normalizeText(value).toLowerCase();
  return STATUS_NAMES[status] ?? (status ? status[0]!.toUpperCase() + status.slice(1) : "");
}

const YOUTUBE_ID = /^[\w-]{11}$/;

export type VideoResult =
  | { kind: "youtube"; value: string }
  | { kind: "facebook"; value: string }
  | { kind: "link"; value: string }
  | { kind: "text"; value: string }
  | { kind: "none" };

/**
 * The "youtube" field holds YouTube ids or URLs, Facebook video URLs, and sometimes unrelated
 * things (a website, a person's name). Only the first two are playable videos.
 */
export function classifyVideo(value: Text): VideoResult {
  const raw = (value ?? "").replace(/&amp;/g, "&").trim();
  if (!raw) return { kind: "none" };
  if (YOUTUBE_ID.test(raw)) return { kind: "youtube", value: raw };

  const youtube = raw.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/,
  );
  if (youtube) return { kind: "youtube", value: youtube[1]! };

  if (/facebook\.com\/.+\/videos\//.test(raw) || /fb\.watch\//.test(raw)) {
    return { kind: "facebook", value: raw };
  }
  if (/^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(raw)) {
    return { kind: "link", value: raw.startsWith("http") ? raw : `https://${raw}` };
  }
  return { kind: "text", value: raw };
}

// What still looks broken after the cleanup, for the report: each is a kind of problem that
// shouldn't be in text a visitor reads
const PROBLEMS: [string, RegExp][] = [
  ["markup", /<\/?[a-z][\w:-]*(?:\s[^<>]*)?\/?>|<\/\s*$|\b[a-z]+="[^"]*"/i],
  ["HTML entity", /&(?:#x[\da-f]+|#\d+|[a-z]+);/i],
  // UTF-8 read as Latin-1: "Ã¨" for "è", "â€™" for "'"
  ["broken encoding", /Ã[\u0080-\u00bf]|â€|Â[\u00a0-\u00bf]/],
  ["unknown character", /\ufffd/],
  // oxlint-disable-next-line no-control-regex -- finding them is the point
  ["control character", /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/],
];

/** The problems found in a text, each with a short excerpt around it. */
export function textProblems(value: Text): { problem: string; excerpt: string }[] {
  const text = value ?? "";
  return PROBLEMS.flatMap(([problem, pattern]) => {
    const match = pattern.exec(text);
    if (!match) return [];
    const start = Math.max(0, match.index - 30);
    const excerpt = text.slice(start, match.index + match[0].length + 30).replace(/\s+/g, " ");
    return [{ problem, excerpt: `${start ? "…" : ""}${excerpt}…` }];
  });
}
