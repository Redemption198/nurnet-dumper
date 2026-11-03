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

// A paragraph that ends mid-sentence, before one that starts in lowercase: a line wrapped
// upstream, not a paragraph
const ENDS_SENTENCE = /[.!?:;"'»)\]…]$/;
const STARTS_LOWERCASE = /^\p{Ll}/u;
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
        last &&
        ((!ENDS_SENTENCE.test(last) && STARTS_LOWERCASE.test(paragraph)) || ENDS_OPEN.test(last));
      if (wrapped) {
        paragraphs[paragraphs.length - 1] = `${last} ${paragraph}`;
      } else {
        paragraphs.push(paragraph);
      }
      return paragraphs;
    }, [])
    .join("\n\n");
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
