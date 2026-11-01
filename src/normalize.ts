// Cleanup rules for the NurNet data. Each function is small and safe to run twice.

type Text = string | null | undefined;

/** Trim, collapse whitespace, straight apostrophes, and fix doubled ones ("Sa Grutta ''e" -> "Sa Grutta 'e"). */
export function normalizeText(value: Text): string {
  return (value ?? "")
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
  return (value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\s+;(?:\s*;)*\s+/g, "\n\n")
    .split(/\n{2,}/)
    .map((paragraph) => normalizeText(paragraph))
    .filter(Boolean)
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
