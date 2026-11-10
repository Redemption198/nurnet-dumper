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

- `nurnet-index.json` (~170 KB gzipped): one compact row per site with what the list, search and
  map need (`content_id, category_id, name, comune, localita, regione, lon, lat`). Loaded at startup.
- `nurnet-details.json` (~950 KB gzipped): photos, description, source, video, status, verified and
  date by `content_id`. Loaded in the background. Photo URLs are stored relative to `photoBase`.

- `nurnet-visibility.json` (~300 KB gzipped): line of sight between nuraghi, computed by CRS4 on the
  terrain model. One `[a, b, direct, inverse]` row per pair of `content_id`s, the values in
  decimetres: how much of each 15 m tower (the height the model assumes) can be seen from the other.
  Loaded the first time a nuraghe is opened.

`--base` reads either this pair or the older single `nurnet-data.json`.

## Translations

The descriptions are machine translated, one file per language for the app: `nurnet-descriptions.<lang>.json`
(`content_id` → text), which the app downloads the first time a visitor opens a site in that language. The
translations are kept in `translations/<lang>.json` (committed), by a hash of the Italian, so a data refresh only
translates what is new or changed. Each one is checked (paragraphs, length, text left in Italian, the census's terms
kept...); one that fails is left out of the app's file, and that site shows its Italian description.

1. **A local model, for everything** (a few hours, nothing leaves the machine), with
   [mlx-lm](https://github.com/ml-explore/mlx-lm) 0.32 or later:

   ```sh
   vpx src/translate-run.ts            # Qwen3 4B; --lang en, --server path/to/mlx_lm.server
   ```

2. **A hosted model, redoing them all** the daily quota at a time: the ones that failed the checks first, then the
   longest. With an [OpenRouter](https://openrouter.ai) key (its free models allow 1000 requests a day once the
   account has bought credits):

   ```sh
   OPENROUTER_API_KEY=… vpx src/translate-run.ts --engine hosted   # Nemotron 3 Ultra; --limit 1000
   ```

   A free model's provider may log what it is sent: only the census's own public text is.

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
