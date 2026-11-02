// Extra context for each site from the NurNet Geoportale (geo.nurnet.net): elevation, type,
// period, geology, land use, distances. The portal uses its own ids, so sites are matched by
// position and name (same site within a few metres, or nearby with a similar name).

const PORTAL_SITES = "https://geo.nurnet.net/nurnet-portale/protostorico_l2.geojson";

interface PortalProperties {
  nome: string | null;
  archivio: string;
  tipologia: string | null;
  periodo: string | null;
  lito_semplice: string | null;
  uso_suolo: string | null;
  quota_m: number | null;
  dist_corso_m: number | null;
  dist_sorgente_m: number | null;
  dist_costa_m: number | null;
}

export interface SiteContext {
  elevation: number | null;
  typology: string;
  period: string;
  lithology: string;
  landUse: string;
  riverDistance: number | null;
  springDistance: number | null;
  coastDistance: number | null;
}

type LonLat = [number, number];

// Distance in metres (equirectangular, fine at this scale)
function distance([lon1, lat1]: LonLat, [lon2, lat2]: LonLat) {
  const x = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180)) * 111_320;
  const y = (lat2 - lat1) * 110_540;
  return Math.hypot(x, y);
}

const normalizeName = (name: string | null | undefined) =>
  (name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

// Dice coefficient on character bigrams: 1 for identical names, 0 for nothing in common
function similarity(a: string, b: string) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bigram = a.slice(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bigram = b.slice(i, i + 2);
    const count = bigrams.get(bigram) ?? 0;
    if (count > 0) {
      bigrams.set(bigram, count - 1);
      shared++;
    }
  }
  return (2 * shared) / (a.length + b.length - 2);
}

const text = (value: string | null) => (value ?? "").replace(/\s+/g, " ").trim();
const metres = (value: number | null) => (typeof value === "number" ? Math.round(value) : null);

/** Downloads the portal's sites; returns a lookup from a site's name and position to its context. */
export async function loadPortalContext() {
  const response = await fetch(PORTAL_SITES);
  if (!response.ok) throw new Error(`geo.nurnet.net: HTTP ${response.status}`);
  const data = (await response.json()) as {
    features: { geometry: { coordinates: LonLat }; properties: PortalProperties }[];
  };
  // Only NurNet's own archive: the portal also lists landscape-plan sites, finds, churches...
  const portal = data.features.filter((f) => f.properties.archivio === "nurnet_nid");
  console.log(`Fetched ${portal.length} NurNet sites from geo.nurnet.net`);

  // Grid of ~1 km cells for fast neighbour lookup
  const cell = ([lon, lat]: LonLat) => `${Math.round(lon * 100)},${Math.round(lat * 100)}`;
  const grid = new Map<string, number[]>();
  portal.forEach((f, i) => {
    const key = cell(f.geometry.coordinates);
    grid.set(key, [...(grid.get(key) ?? []), i]);
  });

  return (name: string, coordinates: LonLat): SiteContext | null => {
    const [lon, lat] = coordinates;
    const candidates: { index: number; distance: number }[] = [];
    for (const dx of [-1, 0, 1]) {
      for (const dy of [-1, 0, 1]) {
        const key = `${Math.round(lon * 100) + dx},${Math.round(lat * 100) + dy}`;
        for (const index of grid.get(key) ?? []) {
          candidates.push({
            index,
            distance: distance(coordinates, portal[index]!.geometry.coordinates),
          });
        }
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);

    const ours = normalizeName(name);
    const match = candidates
      .slice(0, 5)
      .find(
        ({ index, distance }) =>
          distance <= 200 &&
          (distance < 15 || similarity(ours, normalizeName(portal[index]!.properties.nome)) > 0.6),
      );
    if (!match) return null;

    const p = portal[match.index]!.properties;
    return {
      elevation: metres(p.quota_m),
      typology: text(p.tipologia),
      period: text(p.periodo),
      lithology: text(p.lito_semplice),
      landUse: text(p.uso_suolo),
      riverDistance: metres(p.dist_corso_m),
      springDistance: metres(p.dist_sorgente_m),
      coastDistance: metres(p.dist_costa_m),
    };
  };
}
