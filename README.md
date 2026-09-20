# speed-cameras-worker

Fetches speed cameras and speed-enforcement sections from the Overpass API and
publishes them as GeoJSON datapacks into the
[`speed-cameras`](https://github.com/Ciriak/speed-cameras) data repository.
Which countries get exported is set in [`config.json`](config.json).

## How it works

This repository only holds the worker. `npm run fetch` queries Overpass and
writes one datapack per collection and country:

```
<country>-cameras.json   speed cameras as Point features
<country>-areas.json     enforcement sections as LineString/MultiLineString features
```

Every file carries the OSM snapshot date it was built from in `version`, plus a
`url` clients can poll. That URL points at the data repository, so a run here
never changes what clients download.

A GitHub Action does the same monthly and on demand from the Actions tab. It
checks out `Ciriak/speed-cameras`, fetches, and commits the refreshed files
there as `Updated to version <version>`; this worker repository stays clean
because its own JSON files are gitignored.

## Run it

```bash
npm install
npm run fetch        # every country in config.json
npm run fetch -- fr  # a single country code
```

Files are written to the repository root unless `OUTPUT_DIR` says otherwise. To
write into a checkout of the data repository instead:

```bash
OUTPUT_DIR=./data npm run fetch
```

On PowerShell: `$env:OUTPUT_DIR='./data'; npm run fetch`.

## Configure

- `countries` — the two-letter ISO codes to export, each with optional `name`,
  `tag` and `cameras` / `areas` overrides (description, tags, id, file name).
- `defaults` — the per-file settings every country starts from.
- `urlBase` — base of the `url` property of every file. Point it at your own raw
  base (`https://raw.githubusercontent.com/<you>/<repo>/<branch>`) or any other
  host, such as a CDN, to publish your own data.
- Placeholders are `{code}`, `{CODE}`, `{country}` and `{countryTag}`.

Environment variables:

- `OUTPUT_DIR` — where the datapacks are written; defaults to this repository,
  relative paths are resolved against it.
- `COUNTRY_CODE` — alternative to the country code CLI argument.
- `CONFIG_PATH` — config file to read instead of `config.json`.
- `OVERPASS_URL` — one endpoint, or a comma-separated list replacing the defaults.
- `UPDATE_BASE_URL` — overrides `urlBase`, for example to serve the data from a CDN.

## Publishing setup

The workflow needs a repository secret `DATA_REPO_TOKEN`: a fine-grained
personal access token with `Contents: read and write` on `Ciriak/speed-cameras`.
This repository itself no longer needs write access to publish data. The
optional repository variable `DATA_REPO_BRANCH` overrides the branch pushed to,
which defaults to `master`.

## Attribution

Data &copy; OpenStreetMap contributors, available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
