// NurNet Dumper 2: fetches the NurNet sites and photos from the CRS4 GeoServer (two requests)
// and merges them into the existing NurNet+ data. Nothing is overwritten: the result and a
// report of every change go to the output folder, to review before replacing the app's data.
//
// The app's data is split in two: a small index (what the list, search and map need, loaded at
// startup) and the details (photos, description...: loaded in the background).
//
//   vpx src/index.ts [--base ../nurnet-plus/public] [--out out]

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  classifyVideo,
  extractLinks,
  type Link,
  normalizeParagraphs,
  normalizeStatus,
  normalizeText,
  recoverLeakedRecord,
  sourceAddress,
  textProblems,
  type VideoResult,
} from "./normalize.ts";
import { loadPortalContext, type SiteContext } from "./portal.ts";

const WFS =
  "https://nurnet.crs4.it/geoserver/nurnet/ows?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json&srsName=EPSG:4326";

interface UpstreamSite {
  contentid: string;
  category: string | null;
  nome: string | null;
  comune: string | null;
  localita: string | null;
  regione: string | null;
  fonte: string | null;
  youtube: string | null;
  descr_it: string | null;
}

interface Properties {
  content_id: string;
  category_id: string | null;
  name: string;
  comune: string;
  localita: string;
  regione: string;
  source: string;
  description: string;
  // The web addresses that were in the description
  links: Link[];
  youtube: string;
  stato: string;
  verified: boolean | null;
  date: string | null;
  photos: string[];
}

interface Feature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: Properties & Partial<SiteContext>;
}

const CONTEXT_FIELDS = [
  "elevation",
  "typology",
  "period",
  "lithology",
  "landUse",
  "riverDistance",
  "springDistance",
  "coastDistance",
] as const;

const { values: args } = parseArgs({
  options: {
    // The NurNet+ public folder: nurnet-index.json + nurnet-details.json, or the older
    // single nurnet-data.json
    base: { type: "string", default: "../nurnet-plus/public" },
    out: { type: "string", default: "out" },
    // Keep sites that are only in the base file (e.g. added by hand) instead of following upstream
    "keep-local": { type: "boolean", default: false },
  },
});

// The CRS4 server drops out from time to time: retry a few times before giving up.
// `properties` limits the columns (leaving out the geometry when it isn't listed)
async function fetchLayer<T>(layer: string, properties?: string[], attempts = 3) {
  const columns = properties ? `&propertyName=${properties.join(",")}` : "";
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${WFS}&typeNames=nurnet:${layer}${columns}`, {
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as {
        features: { geometry: { coordinates: [number, number] }; properties: T }[];
      };
      console.log(`Fetched ${data.features.length} features from nurnet:${layer}`);
      return data.features;
    } catch (error) {
      if (attempt >= attempts)
        throw new Error(`nurnet:${layer}: ${String(error)}`, { cause: error });
      console.warn(
        `nurnet:${layer} failed (${String(error)}), retrying (${attempt}/${attempts - 1})…`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt));
    }
  }
}

// Distance in metres between two lon/lat points (equirectangular, fine at this scale)
function distance([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]) {
  const x = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180)) * 111_320;
  const y = (lat2 - lat1) * 110_540;
  return Math.hypot(x, y);
}

console.log("NurNet Dumper 2");

// Index rows: the fields the list, search and map need, in this order
const INDEX_FIELDS = [
  "content_id",
  "category_id",
  "name",
  "comune",
  "localita",
  "regione",
] as const;
// Photo URLs share this prefix: stored without it, the app adds it back
const PHOTO_BASE = "https://www.nurnet.net/mediateca/wp-content/uploads/sites/2/";

type BaseFeature = { geometry: Feature["geometry"]; properties: Partial<Feature["properties"]> };

async function readBase(dir: string): Promise<BaseFeature[]> {
  const exists = (file: string) =>
    access(`${dir}/${file}`).then(
      () => true,
      () => false,
    );
  const readJson = async (file: string) => JSON.parse(await readFile(`${dir}/${file}`, "utf8"));

  if (await exists("nurnet-index.json")) {
    const index = await readJson("nurnet-index.json");
    const details = await readJson("nurnet-details.json");
    return (index.rows as unknown[][]).map((row) => {
      const properties = Object.fromEntries(INDEX_FIELDS.map((field, i) => [field, row[i]]));
      const extra = details.sites[properties.content_id as string] ?? {};
      return {
        geometry: { type: "Point", coordinates: [row[6], row[7]] as [number, number] },
        properties: {
          ...properties,
          ...extra,
          photos: (extra.photos ?? []).map((url: string) =>
            url.startsWith("http") ? url : details.photoBase + url,
          ),
        },
      };
    });
  }
  const single = await readJson("nurnet-data.json");
  return single.features;
}

const base = await readBase(args.base!);
const ours = new Map(base.map((f) => [f.properties.content_id!, f]));
console.log(`Read ${ours.size} sites from ${args.base}`);

const [crs4, contextFor] = await Promise.all([
  Promise.all([
    fetchLayer<UpstreamSite>("nurdata"),
    fetchLayer<{ code: string; url: string }>("nurmedia"),
  ]).catch((error: unknown) => {
    console.warn(`CRS4 unavailable, keeping the current sites and photos: ${String(error)}`);
    return null;
  }),
  // Optional: without it, each site keeps the context it already had
  loadPortalContext().catch((error: unknown) => {
    console.warn(`geo.nurnet.net unavailable, keeping the existing context: ${String(error)}`);
    return null;
  }),
]);

// Line of sight between nuraghi, computed by CRS4 on the terrain model. One row per pair, no
// geometry (the app has the coordinates). `direct` and `inverse` (0-15, metres: 15 m is the tower
// height the model assumes) are how much of each tower can be seen from the other
const visibility = await fetchLayer<{
  source: string;
  target: string;
  direct: string;
  inverse: string;
}>("visibility", ["source", "target", "direct", "inverse"]).catch((error: unknown) => {
  console.warn(`CRS4 visibility unavailable, keeping the existing file: ${String(error)}`);
  return null;
});

// With CRS4 down, the current data stands in for it, so the other sources can still update
const sites =
  crs4?.[0] ??
  base.map(({ geometry, properties: p }) => ({
    geometry,
    properties: {
      contentid: p.content_id!,
      category: p.category_id ?? null,
      nome: p.name ?? null,
      comune: p.comune ?? null,
      localita: p.localita ?? null,
      regione: p.regione ?? null,
      fonte: p.source ?? null,
      youtube: p.youtube ?? null,
      descr_it: p.description ?? null,
    } satisfies UpstreamSite,
  }));
const media =
  crs4?.[1] ??
  base.flatMap(({ properties: p }) =>
    (p.photos ?? []).map((url) => ({ properties: { code: p.content_id!, url } })),
  );

const photosById = new Map<string, string[]>();
for (const { properties } of media) {
  const list = photosById.get(properties.code) ?? [];
  list.push(properties.url);
  photosById.set(properties.code, list);
}

const report = {
  added: [] as string[],
  onlyOurs: [] as string[],
  renamed: [] as string[],
  recategorised: [] as string[],
  moved: [] as string[],
  sourceChanged: 0,
  newDescriptions: 0,
  context: { matched: 0, kept: 0, none: 0 },
  videoFixes: [] as string[],
  statusFixes: 0,
  photos: { sitesBefore: 0, sitesAfter: 0, added: 0 },
  textFixes: [] as string[],
  sentenceSpacing: 0,
  joinedParagraphs: 0,
  textProblems: [] as string[],
};

// The text fields a visitor reads, checked and listed in the report when cleaned up
const TEXT_FIELDS = ["name", "comune", "localita", "regione", "source", "description"] as const;

// Notes for the report on what the cleanup in normalize.ts changed in a site's upstream text
function noteTextFixes(id: string, raw: Record<(typeof TEXT_FIELDS)[number], string | null>) {
  for (const field of TEXT_FIELDS) {
    const value = raw[field] ?? "";
    if (field === "description" && recoverLeakedRecord(value) !== value) {
      report.textFixes.push(`${id} description: a raw portal record, only its note kept`);
    }
    if (/&(?:#x[\da-f]+|#\d+|[a-z]+);/i.test(value)) {
      report.textFixes.push(`${id} ${field}: HTML entities decoded`);
    }
    if (/\p{L}[<>]\p{L}/u.test(recoverLeakedRecord(value))) {
      report.textFixes.push(
        `${id} ${field}: stray < or > removed from "${normalizeText(value).slice(0, 60)}"`,
      );
    }
  }
  for (const field of TEXT_FIELDS) {
    if (/Ã[\u0080-\u00bf]|Â[\u00a0-\u00bf]|â€/.test(raw[field] ?? "")) {
      report.textFixes.push(`${id} ${field}: broken encoding fixed`);
    }
  }
  const description = raw.description ?? "";
  if (/\p{Ll}{3}\.\p{Lu}\p{Ll}/u.test(description)) report.sentenceSpacing++;
  if (
    /[^.!?:;"'»)\]…\s]\s*(?:\n\s*\n|\s;(?:\s*;)*\s)\s*\p{Ll}/u.test(
      recoverLeakedRecord(description),
    )
  ) {
    report.joinedParagraphs++;
  }
}

const label = (p: { content_id?: string; name?: string; comune?: string }) =>
  `${p.content_id} ${p.name}${p.comune ? ` (${p.comune})` : ""}`;

// The video field gets only playable videos; websites become the source if there is none
function resolveVideo(id: string, candidates: (string | null | undefined)[], source: string) {
  let video: VideoResult = { kind: "none" };
  for (const candidate of candidates) {
    const result = classifyVideo(candidate);
    if (result.kind === "youtube" || result.kind === "facebook") return { video: result, source };
    if (video.kind === "none") video = result;
  }
  if (video.kind === "link" && !source) {
    report.videoFixes.push(
      `${id}: website moved from the video field to the source: ${video.value}`,
    );
    return { video: { kind: "none" } as VideoResult, source: video.value };
  }
  if (video.kind === "link" || video.kind === "text") {
    report.videoFixes.push(`${id}: not a video, removed from the video field: "${video.value}"`);
  }
  return { video: { kind: "none" } as VideoResult, source };
}

const features: Feature[] = [];

for (const site of sites) {
  const up = site.properties;
  const id = up.contentid;
  const existing = ours.get(id);
  const previous = existing?.properties ?? {};

  let source = normalizeText(up.fonte);
  // A Facebook video put in the source field belongs in the video field
  const sourceAsVideo = classifyVideo(source);
  const videoCandidates = [up.youtube, previous.youtube];
  if (sourceAsVideo.kind === "facebook") {
    videoCandidates.push(source);
    source = "";
  }
  const resolved = resolveVideo(id, videoCandidates, source);
  const youtube = resolved.video.kind === "none" ? "" : resolved.video.value;
  const previousVideo = classifyVideo(previous.youtube);
  if (youtube && previous.youtube !== youtube && previousVideo.kind !== "none") {
    report.videoFixes.push(`${id}: video "${previous.youtube}" -> "${youtube}"`);
  }

  const status = normalizeStatus(previous.stato);
  if (previous.stato && status !== previous.stato) report.statusFixes++;

  const photos = [...new Set([...(previous.photos ?? []), ...(photosById.get(id) ?? [])])];
  if (previous.photos?.length) report.photos.sitesBefore++;
  if (photos.length) report.photos.sitesAfter++;
  report.photos.added += photos.length - (previous.photos?.length ?? 0);

  noteTextFixes(id, {
    name: up.nome,
    comune: up.comune,
    localita: up.localita,
    regione: up.regione,
    source: up.fonte,
    description: up.descr_it,
  });

  // The description's web addresses become links. With CRS4 down the description is our own, its
  // addresses already out: the links it had stay
  const described = extractLinks(normalizeParagraphs(up.descr_it));
  const properties: Feature["properties"] = {
    content_id: id,
    category_id: up.category ?? null,
    name: normalizeText(up.nome),
    comune: normalizeText(up.comune),
    localita: normalizeText(up.localita),
    regione: normalizeText(up.regione),
    source: sourceAddress(resolved.source),
    description: described.text,
    links: described.links.length || crs4 ? described.links : (previous.links ?? []),
    youtube,
    // Not published upstream any more: keep what we have
    stato: status,
    verified: previous.verified ?? null,
    date: previous.date ?? null,
    photos,
  };
  const coordinates = site.geometry.coordinates;

  // Context from geo.nurnet.net, or what the site already had if the portal is unavailable
  const context = contextFor?.(properties.name, coordinates);
  if (context) {
    Object.assign(properties, context);
    report.context.matched++;
  } else if (!contextFor && CONTEXT_FIELDS.some((field) => previous[field] != null)) {
    for (const field of CONTEXT_FIELDS) Object.assign(properties, { [field]: previous[field] });
    report.context.kept++;
  } else {
    report.context.none++;
  }

  if (!existing) {
    report.added.push(label(properties));
  } else {
    if (normalizeText(previous.name) !== properties.name) {
      report.renamed.push(`${id}: "${previous.name}" -> "${properties.name}"`);
    }
    if (String(previous.category_id) !== String(properties.category_id)) {
      report.recategorised.push(
        `${label(properties)}: ${previous.category_id} -> ${properties.category_id}`,
      );
    }
    const moved = distance(existing.geometry.coordinates, coordinates);
    if (moved > 50) report.moved.push(`${label(properties)}: ${Math.round(moved)} m`);
    if (normalizeText(previous.source) !== properties.source) report.sourceChanged++;
  }
  if (properties.description) report.newDescriptions++;

  features.push({ type: "Feature", geometry: { type: "Point", coordinates }, properties });
}

// Sites only in our file (removed upstream, or added by hand): listed in the report, and
// dropped to follow upstream unless --keep-local
const upstreamIds = new Set(sites.map((s) => s.properties.contentid));
for (const [id, feature] of ours) {
  if (upstreamIds.has(id)) continue;
  const p = feature.properties;
  report.onlyOurs.push(label(p));
  if (!args["keep-local"]) continue;
  const video = classifyVideo(p.youtube);
  features.push({
    type: "Feature",
    geometry: feature.geometry,
    properties: {
      content_id: id,
      category_id: p.category_id ?? null,
      name: normalizeText(p.name),
      comune: normalizeText(p.comune),
      localita: normalizeText(p.localita),
      regione: normalizeText(p.regione),
      source: normalizeText(p.source),
      description: "",
      links: [],
      youtube: video.kind === "youtube" || video.kind === "facebook" ? video.value : "",
      stato: normalizeStatus(p.stato),
      verified: p.verified ?? null,
      date: p.date ?? null,
      photos: p.photos ?? [],
    },
  });
}

// Whatever still looks broken after the cleanup, to fix by hand or with a new rule
for (const { properties } of features) {
  for (const field of TEXT_FIELDS) {
    for (const { problem, excerpt } of textProblems(properties[field])) {
      report.textProblems.push(`${properties.content_id} ${field}: ${problem}: \`${excerpt}\``);
    }
  }
}
if (report.textProblems.length) {
  console.warn(`${report.textProblems.length} text problems left: see the report`);
}

await mkdir(args.out!, { recursive: true });

// Index: one compact row per site, no repeated keys (about a quarter of GeoJSON's size)
const rows = features.map(({ geometry, properties }) => [
  ...INDEX_FIELDS.map((field) => properties[field]),
  Number(geometry.coordinates[0].toFixed(6)),
  Number(geometry.coordinates[1].toFixed(6)),
]);
const generated = new Date().toISOString();
await writeFile(
  `${args.out}/nurnet-index.json`,
  JSON.stringify({ generated, fields: [...INDEX_FIELDS, "lon", "lat"], rows }),
);

// Details: everything else, by content_id, leaving out empty values
const sitesDetails = Object.fromEntries(
  features.map(({ properties }) => {
    const { photos, ...rest } = properties;
    const detail: Record<string, unknown> = Object.fromEntries(
      Object.entries(rest).filter(
        ([key, value]) =>
          !(INDEX_FIELDS as readonly string[]).includes(key) &&
          value !== "" &&
          value !== null &&
          !(Array.isArray(value) && !value.length),
      ),
    );
    if (photos.length) {
      detail.photos = photos.map((url) =>
        url.startsWith(PHOTO_BASE) ? url.slice(PHOTO_BASE.length) : url,
      );
    }
    return [properties.content_id, detail];
  }),
);
await writeFile(
  `${args.out}/nurnet-details.json`,
  JSON.stringify({ generated, photoBase: PHOTO_BASE, sites: sitesDetails }),
);

// Visibility: [a, b, direct, inverse] with the values in decimetres, only between sites we have.
// Without a fresh download, the existing file is copied as it is
const siteIds = new Set(features.map(({ properties }) => properties.content_id));
const visibilityReport = { pairs: 0, sites: 0, dropped: 0, fresh: Boolean(visibility) };
let visibilityFile: string | null = null;
if (visibility) {
  const pairs = [];
  for (const { properties: p } of visibility) {
    if (!siteIds.has(p.source) || !siteIds.has(p.target)) {
      visibilityReport.dropped++;
      continue;
    }
    pairs.push([
      p.source,
      p.target,
      Math.round(Number(p.direct) * 10),
      Math.round(Number(p.inverse) * 10),
    ]);
  }
  visibilityReport.pairs = pairs.length;
  visibilityReport.sites = new Set(pairs.flatMap(([a, b]) => [a, b])).size;
  visibilityFile = JSON.stringify({
    generated,
    fields: ["a", "b", "direct_dm", "inverse_dm"],
    pairs,
  });
} else {
  visibilityFile = await readFile(`${args.base}/nurnet-visibility.json`, "utf8").catch(() => null);
}
if (visibilityFile) await writeFile(`${args.out}/nurnet-visibility.json`, visibilityFile);

const section = (title: string, lines: string[]) =>
  `## ${title} (${lines.length})\n\n${lines.length ? lines.map((l) => `- ${l}`).join("\n") : "_none_"}\n`;

const markdown = `# NurNet data refresh

${crs4 ? `Fetched ${new Date().toISOString()} from the CRS4 GeoServer (nurdata, nurmedia).` : `**CRS4 was unavailable (${new Date().toISOString()}): sites and photos are the current ones**, only the other sources were updated.`}

| | |
|---|---|
| Sites before | ${ours.size} |
| Sites after | ${features.length} |
| New upstream | ${report.added.length} |
| Only in our file (${args["keep-local"] ? "kept" : "removed, as upstream"}) | ${report.onlyOurs.length} |
| Renamed (after normalisation) | ${report.renamed.length} |
| Category changed | ${report.recategorised.length} |
| Moved more than 50 m | ${report.moved.length} |
| Source changed | ${report.sourceChanged} |
| Sites with a description | ${report.newDescriptions} |
| Context from geo.nurnet.net | ${report.context.matched} matched, ${report.context.kept} kept from before, ${report.context.none} without |
| Status values fixed | ${report.statusFixes} |
| Video field fixes | ${report.videoFixes.length} |
| Text fixes | ${report.textFixes.length}, plus a space added after full stops in ${report.sentenceSpacing} descriptions, and paragraphs broken mid-sentence joined in ${report.joinedParagraphs} |
| **Text problems left** | ${report.textProblems.length} |
| Sites with photos | ${report.photos.sitesBefore} -> ${report.photos.sitesAfter} (+${report.photos.added} photos) |
| Line of sight | ${visibilityReport.fresh ? `${visibilityReport.pairs} pairs between ${visibilityReport.sites} sites, ${visibilityReport.dropped} dropped (site not in the data)` : visibilityFile ? "CRS4 unavailable: existing file kept" : "CRS4 unavailable: no file"} |

${section("Text problems left (fix by hand or add a rule to normalize.ts)", report.textProblems)}
${section("Text fixes", report.textFixes)}
${section("Video field fixes", report.videoFixes)}
${section(`Only in our file (${args["keep-local"] ? "kept" : "removed, as upstream"})`, report.onlyOurs)}
${section("New upstream", report.added)}
${section("Category changed", report.recategorised)}
${section("Moved more than 50 m", report.moved)}
${section("Renamed", report.renamed)}`;

await writeFile(`${args.out}/report.md`, markdown);
console.log(
  `Wrote ${features.length} sites to ${args.out}/nurnet-index.json + nurnet-details.json${visibilityFile ? " + nurnet-visibility.json" : ""} and the report to ${args.out}/report.md`,
);
