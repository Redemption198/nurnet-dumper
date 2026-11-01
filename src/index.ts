// NurNet Dumper 2: fetches the NurNet sites and photos from the CRS4 GeoServer (two requests)
// and merges them into an existing NurNet+ data file. Nothing is overwritten: the result and a
// report of every change go to the output folder, to review before replacing the app's data.
//
//   vpx src/index.ts [--base ../nurnet-plus/public/nurnet-data.json] [--out out]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  classifyVideo,
  normalizeParagraphs,
  normalizeStatus,
  normalizeText,
  type VideoResult,
} from "./normalize.ts";

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
  youtube: string;
  stato: string;
  verified: boolean | null;
  date: string | null;
  photos: string[];
}

interface Feature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: Properties;
}

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "../nurnet-plus/public/nurnet-data.json" },
    out: { type: "string", default: "out" },
    // Keep sites that are only in the base file (e.g. added by hand) instead of following upstream
    "keep-local": { type: "boolean", default: false },
  },
});

async function fetchLayer<T>(layer: string) {
  const response = await fetch(`${WFS}&typeNames=nurnet:${layer}`);
  if (!response.ok) throw new Error(`${layer}: HTTP ${response.status}`);
  const data = (await response.json()) as {
    features: { geometry: { coordinates: [number, number] }; properties: T }[];
  };
  console.log(`Fetched ${data.features.length} features from nurnet:${layer}`);
  return data.features;
}

// Distance in metres between two lon/lat points (equirectangular, fine at this scale)
function distance([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]) {
  const x = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180)) * 111_320;
  const y = (lat2 - lat1) * 110_540;
  return Math.hypot(x, y);
}

console.log("NurNet Dumper 2");
const [sites, media] = await Promise.all([
  fetchLayer<UpstreamSite>("nurdata"),
  fetchLayer<{ code: string; url: string }>("nurmedia"),
]);

const base = JSON.parse(await readFile(args.base!, "utf8")) as {
  features: { geometry: Feature["geometry"]; properties: Partial<Properties> }[];
};
const ours = new Map(base.features.map((f) => [f.properties.content_id!, f]));
console.log(`Read ${ours.size} sites from ${args.base}`);

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
  videoFixes: [] as string[],
  statusFixes: 0,
  photos: { sitesBefore: 0, sitesAfter: 0, added: 0 },
};

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

  const properties: Properties = {
    content_id: id,
    category_id: up.category ?? null,
    name: normalizeText(up.nome),
    comune: normalizeText(up.comune),
    localita: normalizeText(up.localita),
    regione: normalizeText(up.regione),
    source: resolved.source,
    description: normalizeParagraphs(up.descr_it),
    youtube,
    // Not published upstream any more: keep what we have
    stato: status,
    verified: previous.verified ?? null,
    date: previous.date ?? null,
    photos,
  };
  const coordinates = site.geometry.coordinates;

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
      youtube: video.kind === "youtube" || video.kind === "facebook" ? video.value : "",
      stato: normalizeStatus(p.stato),
      verified: p.verified ?? null,
      date: p.date ?? null,
      photos: p.photos ?? [],
    },
  });
}

await mkdir(args.out!, { recursive: true });
await writeFile(
  `${args.out}/nurnet-data.json`,
  JSON.stringify({ type: "FeatureCollection", features }),
);

const section = (title: string, lines: string[]) =>
  `## ${title} (${lines.length})\n\n${lines.length ? lines.map((l) => `- ${l}`).join("\n") : "_none_"}\n`;

const markdown = `# NurNet data refresh

Fetched ${new Date().toISOString()} from the CRS4 GeoServer (nurdata, nurmedia).

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
| Status values fixed | ${report.statusFixes} |
| Video field fixes | ${report.videoFixes.length} |
| Sites with photos | ${report.photos.sitesBefore} -> ${report.photos.sitesAfter} (+${report.photos.added} photos) |

${section("Video field fixes", report.videoFixes)}
${section(`Only in our file (${args["keep-local"] ? "kept" : "removed, as upstream"})`, report.onlyOurs)}
${section("New upstream", report.added)}
${section("Category changed", report.recategorised)}
${section("Moved more than 50 m", report.moved)}
${section("Renamed", report.renamed)}`;

await writeFile(`${args.out}/report.md`, markdown);
console.log(
  `Wrote ${features.length} sites to ${args.out}/nurnet-data.json and the report to ${args.out}/report.md`,
);
