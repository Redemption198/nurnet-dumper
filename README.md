# NurNet Dumper

Fetches the NurNet sites and their photos from the [CRS4 NurNet GeoServer](https://nurnet.crs4.it/nurnetgeo/)
and merges them into the [NurNet+](https://github.com/Redemption198/nurnet-plus) data file.

It makes four requests in total: three WFS layers on CRS4 (`nurnet:nurdata`, `nurnet:nurmedia` and
`nurnet:visibility`, about 11 MB) and one GeoJSON file on geo.nurnet.net.
Version 1 scraped one portal page per site with Puppeteer, which took hours.

## Usage

```bash
vp install
vp run start
# or with other paths:
vpx src/index.ts --base ../nurnet-plus/public --out out
```

Nothing is overwritten: the merged data and a report of every change are written to `out/`.
Review `out/report.md`, then copy the data files into NurNet+:

```bash
cp out/nurnet-index.json out/nurnet-details.json out/nurnet-visibility.json ../nurnet-plus/public/
```

## Output

The app's data is split so it starts fast:

- `nurnet-index.json` (~126 KB gzipped): what the list, search and map need for each site
  (`content_id, category_id, name, comune, localita, regione` and its coordinates), one array per
  field: see [The index format](#the-index-format). Loaded at startup.
- `nurnet-details.json` (~950 KB gzipped): photos, description, source, video, status, verified and
  date by `content_id`. Loaded in the background. Photo URLs are stored relative to `photoBase`.

- `nurnet-visibility.json` (~300 KB gzipped): line of sight between nuraghi, computed by CRS4 on the
  terrain model. One `[a, b, direct, inverse]` row per pair of `content_id`s, the values in
  decimetres: how much of each 15 m tower (the height the model assumes) can be seen from the other.
  Loaded the first time a nuraghe is opened.

`--base` reads either this pair or the older single `nurnet-data.json`.

### The index format

The index is the file the app needs before it can show anything, so it's kept small: one array per
field instead of one row per site, which gzip packs tighter (a quarter smaller than rows, 167 → 126
KB, and faster to parse). Every array lists the sites in the same order, sorted by id: **a site's
position is its key**, and the entry at position _k_ of each array belongs to the _k_-th site.

```json
{
  "format": 2,
  "idPrefix": "NUR",
  "ids": [482, 10, 3],
  "category": { "values": ["10", "30"], "of": [0, 1, 0] },
  "name": ["Nuraghe Simoneddu", "Nuraghe e domus de janas Marajana I e II", "N.ghe Satza de Pranu"],
  "comune": { "values": ["Villaputzu", "Allai", "Busachi"], "of": [0, 1, 2] },
  "localita": { "values": ["Simoneddu", ""], "of": [0, 1, 1] },
  "regione": { "values": ["Sarrabus", "Barigadu"], "of": [0, 1, 1] },
  "lon": [962470, 888427, 886980],
  "lat": [3949412, 3997041, 3998884]
}
```

- `ids`: each id as the difference from the one before (the first as it is), without `idPrefix`:
  482, +10, +3 are NUR482, NUR492, NUR495.
- `name`: as it is, nearly every name being different.
- `category`, `comune`, `localita`, `regione`: their values repeat, so `values` lists each once and
  `of[k]` is where the _k_-th site's value is in it. The second site's `regione.of` is 1: Barigadu.
- `lon`, `lat`: in hundred-thousandths of a degree, 5 decimals (about 1 m, all the census gives):
  962470 is 9.62470.

`src/index-file.ts` writes and reads it (`encodeIndex`, `decodeIndex`); the app reads it in its data
worker (`parseIndex` in `app/workers/nurnet-data.ts`). `--base` reads it as well as the earlier
format, one row per site.

## Translations

The descriptions are machine translated, one file per language for the app: `nurnet-descriptions.<lang>.json`
(`content_id` → text), which the app downloads the first time a visitor opens a site in that language. The
translations are kept in `translations/<lang>.json` (committed), by a hash of the Italian, so a data refresh only
translates what is new or changed. Each one is checked (paragraphs, length, text left in Italian, the census's terms
kept...); one that fails is left out of the app's file, and that site shows its Italian description.

They are translated with Nemotron 3 Ultra on [OpenRouter](https://openrouter.ai), which needs an OpenRouter key:

```sh
OPENROUTER_API_KEY=… vpx src/translate-run.ts   # --lang en, --limit, --model
```

A run translates the descriptions that have no translation yet, then redoes the ones made by the local model: those
that failed the checks first, then the longest. The model's provider may log what it is sent: only the census's own
public text is.

The local model is still there for a run where nothing leaves the machine: `vpx src/translate-run.ts --engine local`
(Qwen3 4B). It needs [mlx-lm](https://github.com/ml-explore/mlx-lm) 0.32 or later, on Apple silicon.

Each run writes `out/nurnet-descriptions.<lang>.json`, to copy to the app's `public/` with the other files. A run
can be stopped at any point (each translation is saved as it comes) and the next one goes on.

To fix a translation by hand, edit its `text` in `translations/<lang>.json` and set `"engine": "human"`: no run
replaces it. The prompt, the glossary of census terms and the checks are in `src/translate.ts`;
`src/translate-sample.ts` compares models or prompts on the same 50 descriptions
(`out/translate-sample/compare.html`).

## How the data is merged

- Name, category, comune, località, region, source and description come from upstream.
- Status, verified and date are not published upstream any more, so the existing values are kept.
- Photos: the existing list plus the upstream ones, without duplicates.
- Sites that exist only in the base file (removed upstream or added by hand) are removed, following
  upstream, and listed in the report. Pass `--keep-local` to keep them.
- Text is normalised: whitespace, straight apostrophes, doubled apostrophes (`''e` -> `'e`).
- The video field only keeps YouTube ids and Facebook video URLs. YouTube URLs become ids, Facebook
  videos found in the source move to the video field, websites move to the source when it is empty,
  and anything else (e.g. a person's name) is removed and listed in the report.
