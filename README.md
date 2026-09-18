# speed-cameras

Speed cameras and speed-enforcement sections, exported from OpenStreetMap
through the Overpass API. Switzerland is the default country; any other
two-letter ISO 3166-1 code works the same way.

## Data files

Files are named after the country code (`<cc>`):

| File | Contents |
| --- | --- |
| `ch-cameras.json` | Speed cameras (`highway=speed_camera`) as `Point` features |
| `ch-areas.json` | Speed enforcement sections (`type=enforcement`, `enforcement=maxspeed` or `average_speed`) as `LineString`/`MultiLineString` features |

Both files use the datapack wrapper
`{ id, version, description, url, tags, data }` where `data` is a GeoJSON
`FeatureCollection`. Every feature carries
`label` (`CAMERA` or `ENF_AREA`), `osmType`, `osmId`, and `speed` (km/h) when the
OSM `maxspeed` tag holds a plain number. A non-numeric value such as `signals`
is kept verbatim in the `maxspeed` property instead.

`url` points at the raw file of this repository on the default branch, so a
client that polls it picks up every refresh:

```
https://raw.githubusercontent.com/Ciriak/speed-cameras/master/ch-cameras.json
https://raw.githubusercontent.com/Ciriak/speed-cameras/master/ch-areas.json
```

Set `UPDATE_BASE_URL` to serve the files from somewhere else (a CDN, or a
different branch) without touching the code.

Enforcement relations that only reference `from`/`to` detector nodes (the usual
mapping in Switzerland) become a `LineString` between those detectors; the few
relations with real `section` way members keep their actual geometry, as a
`MultiLineString` when several ways are involved.

`version` is the date of the OSM snapshot the data was taken from, so identical
data produces identical files.

## Refreshing the data

```bash
npm install
npm run fetch               # every country listed in the config file
npm run fetch -- fr         # only France (configured or ad hoc)
COUNTRY_CODE=de npm run fetch
```

The script queries several Overpass mirrors (`overpass-api.de` first) and writes
all files atomically; set `OVERPASS_URL` to try a custom endpoint first, or to a
comma-separated list to replace the built-in mirrors. `npm run typecheck` runs
the TypeScript compiler.

## Configuration

[`config.json`](config.json) decides what gets exported:

```json
{
  "urlBase": "https://raw.githubusercontent.com/Ciriak/speed-cameras/master",
  "defaults": {
    "cameras": {
      "file": "{code}-cameras.json",
      "id": "speed-cameras-{code}",
      "description": "Speed cameras in {country}",
      "tags": ["speed-camera", "{countryTag}", "{code}"]
    },
    "areas": {
      "file": "{code}-areas.json",
      "id": "speed-areas-{code}",
      "description": "Speed enforcement sections in {country}",
      "tags": ["speed-area", "{countryTag}", "{code}"]
    }
  },
  "countries": [
    {
      "code": "ch",
      "cameras": { "description": "🇨🇭👮 RADAR SWITZERLAND" }
    },
    { "code": "fr", "name": "🇫🇷 France" },
    {
      "code": "de",
      "name": "Germany 🇩🇪",
      "tag": "germany",
      "areas": { "description": "Section controls in {country}" }
    }
  ]
}
```

- `countries` lists what a plain `npm run fetch` exports. `"fr"` is shorthand
  for `{ "code": "fr" }`. Countries requested on the command line are fetched
  even when they are not listed.
- `defaults.cameras` / `defaults.areas` set the file name, datapack id,
  description and tags for every country; a country can override any of those
  fields. Placeholders: `{code}` (`ch`), `{CODE}` (`CH`), `{country}` (the
  display name) and `{countryTag}` (a tag-safe slug).
- An override replaces the default outright, so `"cameras": { "description":
  "🇨🇭👮 RADAR SWITZERLAND" }` ships exactly that string, while placeholders kept
  in an override are still expanded (`"{country} speed cameras"`).
- `name` is the display name used by `{country}`, in descriptions and in the
  logs. It is free text — emoji included, so `"France 🇫🇷"` renders as
  `Speed cameras in France 🇫🇷`. Without `name` the English region name of
  the ISO code is used (`ch` → `Switzerland`), falling back to the upper-case
  code when the region is unknown.
- `tag` overrides the tag slug behind `{countryTag}`. Without it the slug is
  derived from the ISO code's region name, never from `name`, so emoji or
  punctuation cannot end up in `tags`: `United States` → `united-states`,
  `Côte d'Ivoire` → `cote-d-ivoire`.
- File names, datapack ids and the `url` property are built from `{code}`, so
  whatever a display name contains, the artifacts stay ASCII.
- `urlBase` is the base of the `url` property; `UPDATE_BASE_URL` overrides it,
  and `CONFIG_PATH` points the script at a different config file.

Config mistakes fail with the JSON path that caused them, for example
`config.countries[0].code must be a two-letter ISO 3166-1 code ... got "che"`.

## Automation

[`.github/workflows/fetch-speed-cameras.yml`](.github/workflows/fetch-speed-cameras.yml)
runs the fetcher on the first day of every month (`17 3 1 * *`) and on demand
from the Actions tab, where the run takes two inputs: the country code
(default `ch`) and whether the refreshed data should be committed. When the
data changed, the workflow commits the `*-cameras.json` / `*-areas.json` files
back to the branch it runs on with the `github-actions[bot]` identity; the job
also posts a short per-file summary on the run page. It needs the repository to
allow Actions to write (`permissions: contents: write` is declared in the
workflow, but its organisation/repository policy must permit it too).

## Attribution

Data &copy; OpenStreetMap contributors, available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
