# speed-cameras

Speed cameras and speed-enforcement sections, published as GeoJSON datapacks
with a `url` property clients can poll. Which countries get exported is set in
[`config.json`](config.json).

## Feel free to clone

Fork it or clone it and publish your own data. The `url` of every file is built
from `urlBase` in [`config.json`](config.json), so point that at your own raw
base before your first run:

```json
"urlBase": "https://raw.githubusercontent.com/<you>/<repo>/<branch>"
```

Any other base works too, for example a CDN or a static host:
`https://cdn.example.com/speed-cameras`.

## Run it

```bash
npm install
npm run fetch        # every country in config.json
npm run fetch -- fr  # a single country code
```

A GitHub Action does the same monthly and on demand from the Actions tab, and
commits the refreshed data as `Updated to version <version>`.

## Configure

- `countries` — the two-letter ISO codes to export, each with optional `name`,
  `tag` and `cameras` / `areas` overrides (description, tags, id, file name).
- `defaults` — the per-file settings every country starts from.
- Placeholders are `{code}`, `{CODE}`, `{country}` and `{countryTag}`.

## Attribution

Data &copy; OpenStreetMap contributors, available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
