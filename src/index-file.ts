// nurnet-index.json, the file the app loads first (list, search, map): one array per field
// rather than one row per site, which gzip packs tighter (about 25% smaller than rows).
// - the sites sorted by id, the ids as the differences between them, without their "NUR"
// - the fields that repeat (category, comune, localita, regione) as a list of their values and,
//   per site, the index of its value
// - the coordinates as integers, in hundred-thousandths of a degree (5 decimals, about 1 m:
//   all the census has)

export interface IndexSite {
  content_id: string;
  category_id: string | null;
  name: string;
  comune: string;
  localita: string;
  regione: string;
  lon: number;
  lat: number;
}

interface Values<T> {
  values: T[];
  of: number[];
}

export interface IndexFile {
  generated: string;
  format: 2;
  idPrefix: string;
  ids: number[];
  category: Values<string | null>;
  name: string[];
  comune: Values<string>;
  localita: Values<string>;
  regione: Values<string>;
  lon: number[];
  lat: number[];
}

const ID_PREFIX = "NUR";
const SCALE = 1e5;

function valuesOf<T>(column: T[]): Values<T> {
  const values = [...new Set(column)];
  const position = new Map(values.map((value, i) => [value, i]));
  return { values, of: column.map((value) => position.get(value)!) };
}

export function encodeIndex(sites: IndexSite[], generated: string): IndexFile {
  const numbers = sites.map(({ content_id }) => {
    const number = content_id.startsWith(ID_PREFIX)
      ? Number(content_id.slice(ID_PREFIX.length))
      : NaN;
    if (!Number.isInteger(number))
      throw new Error(`Site id not ${ID_PREFIX} and a number: ${content_id}`);
    return number;
  });
  const order = sites.map((_, i) => i).sort((a, b) => numbers[a]! - numbers[b]!);
  const sorted = order.map((i) => sites[i]!);
  const ids = order.map((i, k) => numbers[i]! - (k ? numbers[order[k - 1]!]! : 0));
  const coordinate = (value: number) => {
    const scaled = value * SCALE;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-6)
      throw new Error(`Coordinate with more than 5 decimals: ${value}`);
    return Math.round(scaled);
  };
  return {
    generated,
    format: 2,
    idPrefix: ID_PREFIX,
    ids,
    category: valuesOf(sorted.map((site) => site.category_id)),
    name: sorted.map((site) => site.name),
    comune: valuesOf(sorted.map((site) => site.comune)),
    localita: valuesOf(sorted.map((site) => site.localita)),
    regione: valuesOf(sorted.map((site) => site.regione)),
    lon: sorted.map((site) => coordinate(site.lon)),
    lat: sorted.map((site) => coordinate(site.lat)),
  };
}

export function decodeIndex(file: IndexFile): IndexSite[] {
  let id = 0;
  return file.ids.map((difference, i) => {
    id += difference;
    return {
      content_id: `${file.idPrefix}${id}`,
      category_id: file.category.values[file.category.of[i]!]!,
      name: file.name[i]!,
      comune: file.comune.values[file.comune.of[i]!]!,
      localita: file.localita.values[file.localita.of[i]!]!,
      regione: file.regione.values[file.regione.of[i]!]!,
      lon: file.lon[i]! / SCALE,
      lat: file.lat[i]! / SCALE,
    };
  });
}
