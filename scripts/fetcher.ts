#!/usr/bin/env node
/**
 * Fetches speed cameras and speed-enforcement sections from the Overpass API
 * and writes one datapack file per collection and country:
 *
 *   <country>-cameras.json  speed cameras as Point features
 *   <country>-areas.json    enforcement sections as LineString/MultiLineString features
 *
 * Which countries are exported is configured in `config.json`.
 * Data (c) OpenStreetMap contributors, available under the ODbL 1.0 licence.
 *
 * Usage:
 *   npm run fetch               # every country listed in the config file
 *   npm run fetch -- fr         # only France
 *   COUNTRY_CODE=de npm run fetch
 *   CONFIG_PATH=./other.json npm run fetch
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
  Point,
} from 'geojson'

type Position = [number, number]

type OverpassCoordinates = { lat: number; lon: number }

type OverpassMember = {
  type: string
  ref: number
  role?: string
  lat?: number
  lon?: number
  geometry?: OverpassCoordinates[]
}

type OverpassElement = {
  type: string
  id: number
  lat?: number
  lon?: number
  center?: OverpassCoordinates
  geometry?: OverpassCoordinates[]
  members?: OverpassMember[]
  tags?: Record<string, string>
}

type OverpassResponse = {
  version?: number
  remark?: string
  osm3s?: { timestamp_osm_base?: string }
  elements?: OverpassElement[]
}

type OverpassPayload = {
  elements: OverpassElement[]
  timestamp: string
}

type DatapackGeometry = Point | LineString | MultiLineString

type DatapackProperties = {
  label: string
  speed?: number
  maxspeed?: string
  osmType: 'node' | 'relation'
  osmId: number
}

type DatapackFeature = Feature<DatapackGeometry, DatapackProperties>
type DatapackData = FeatureCollection<DatapackGeometry, DatapackProperties>

type DatapackFile = {
  id: string
  version: string
  description: string
  /** Raw location clients poll to auto-update this file. */
  url: string
  tags: string[]
  data: DatapackData
}

/** Everything that can be configured for one of the two files of a country. */
export type FileSettings = {
  /** File name, written to the repository root. */
  file: string
  /** Datapack id. */
  id: string
  description: string
  tags: string[]
}

export type SpeedCamerasConfig = {
  /** Base of the `url` property of every file. */
  urlBase: string
  defaults: { cameras: FileSettings; areas: FileSettings }
  countries: {
    code: string
    /** Display name, free text (emoji allowed); defaults to the English region name. */
    name?: string
    /** Tag used for `{countryTag}`; defaults to a slug of the region name. */
    tag?: string
    cameras?: Partial<FileSettings>
    areas?: Partial<FileSettings>
  }[]
}

/** A config entry with every field resolved and templated for one country. */
export type CountryConfig = {
  /** Lower-case ISO 3166-1 alpha-2 code. */
  code: string
  /** Upper-case code as used inside the Overpass query. */
  isoCode: string
  /** Country name used in descriptions and tags. */
  name: string
  /** Lower-case tag slug used for the `{countryTag}` placeholder. */
  countryTag: string
  cameraQuery: string
  areaQuery: string
  cameras: FileSettings
  areas: FileSettings
}

type Snapshot = {
  elements: OverpassElement[]
  mirror: string
  timestamp: string
}

type CountrySnapshot = {
  country: CountryConfig
  version: string
  cameras: Snapshot
  areas: Snapshot
  warnings: string[]
  cameraFeatures: DatapackFeature[]
  areaFeatures: DatapackFeature[]
}

const REPO_ROOT = resolve(__dirname, '..')

const USER_AGENT = 'speed-cameras/1.0 (+https://github.com/Ciriak/speed-cameras)'
const DEFAULT_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]
const ATTEMPTS_PER_MIRROR = 2
const ATTEMPT_TIMEOUT_MS = 60_000
const RETRY_DELAY_MS = 5_000
const MAX_SNAPSHOT_AGE_DAYS = 7
const COORDINATE_PRECISION = 7

const DEFAULT_COUNTRY_CODE = 'ch'
const COUNTRY_CODE_PATTERN = /^[a-z]{2}$/

const CONFIG_FILE_NAME = 'config.json'

/**
 * Base of the `url` property, which points at the committed files. It targets
 * the default branch so the URL stays valid after a run on a side branch is
 * merged. `UPDATE_BASE_URL` overrides the config file, for example to serve the
 * data from a CDN.
 */
const DEFAULT_URL_BASE = 'https://raw.githubusercontent.com/Ciriak/speed-cameras/master'

const CAMERA_LABEL = 'CAMERA'
const AREA_LABEL = 'ENF_AREA'

/** Accepts plain speeds such as "50" or "50 km/h"; zones like "CH:urban" do not match. */
const MAXSPEED_PATTERN = /^(\d+(?:[.,]\d+)?)\s*(?:km\/h|kmh|kph)?$/i

/** Role order used when an enforcement relation has to be rebuilt from node members. */
const NODE_ROLE_ORDER = ['from', 'device', 'to']

/**
 * Placeholders usable in the config file:
 * `{code}` Switzerland -> ch, `{CODE}` -> CH, `{country}` -> the display name
 * (the configured one, which may contain emoji, or the English region name),
 * `{countryTag}` -> a tag-safe slug, `switzerland`.
 */
const BUILT_IN_FILE_SETTINGS: { cameras: FileSettings; areas: FileSettings } = {
  cameras: {
    file: '{code}-cameras.json',
    id: 'speed-cameras-{code}',
    description: 'Speed cameras in {country}',
    tags: ['speed-camera', '{countryTag}', '{code}'],
  },
  areas: {
    file: '{code}-areas.json',
    id: 'speed-areas-{code}',
    description: 'Speed enforcement sections in {country}',
    tags: ['speed-area', '{countryTag}', '{code}'],
  },
}

const COUNTRY_KEYS = ['code', 'name', 'tag', 'cameras', 'areas']
const ROOT_KEYS = ['urlBase', 'defaults', 'countries']
const FILE_KEYS = ['file', 'id', 'description', 'tags']

/**
 * `{{geocodeArea:Switzerland}}` is an Overpass Turbo shortcut that the API does
 * not understand, so the country is selected through its ISO 3166-1 area.
 */
export function buildAreaFilter(isoCode: string): string {
  return `area["ISO3166-1"="${isoCode}"]["admin_level"="2"]->.searchArea;`
}

export function buildCameraQuery(isoCode: string): string {
  return `[out:json][timeout:180];
${buildAreaFilter(isoCode)}
node["highway"="speed_camera"](area.searchArea);
out tags center;`
}

export function buildAreaQuery(isoCode: string): string {
  return `[out:json][timeout:180];
${buildAreaFilter(isoCode)}
(
relation["type"="enforcement"]["enforcement"="maxspeed"](area.searchArea);
relation["type"="enforcement"]["enforcement"="average_speed"](area.searchArea);
);
out geom;`
}

/** English name of a region, falling back to the code itself. */
export function describeCountry(isoCode: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(isoCode)
    if (name && name.toUpperCase() !== isoCode) return name
  } catch {
    // Malformed or unsupported codes fall through to the plain code.
  }

  console.warn(`warning: no English region name known for ${isoCode}, using the code as the name`)
  return isoCode
}

function expandTemplates(value: string, tokens: Record<string, string>): string {
  return value.replace(/\{(\w+)\}/g, (match, token: string) => tokens[token] ?? match)
}

/**
 * Turns a region name into a tag-safe slug, so a display name with emoji or
 * punctuation never ends up inside `tags`.
 */
export function slugifyTag(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug.length > 0 ? slug : 'unknown'
}

function expandFileSettings(settings: FileSettings, tokens: Record<string, string>): FileSettings {
  return {
    file: expandTemplates(settings.file, tokens),
    id: expandTemplates(settings.id, tokens),
    description: expandTemplates(settings.description, tokens),
    tags: settings.tags.map((tag) => expandTemplates(tag, tokens)),
  }
}

function expectRecord(value: unknown, path: string, allowedKeys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object in ${CONFIG_FILE_NAME}`)
  }

  const record = value as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter((key) => !allowedKeys.includes(key))
  if (unknownKeys.length > 0) {
    throw new Error(
      `${path} has unknown ${unknownKeys.length === 1 ? 'key' : 'keys'} ` +
        `${unknownKeys.map((key) => `"${key}"`).join(', ')} in ${CONFIG_FILE_NAME}` +
        ` (allowed: ${allowedKeys.join(', ')})`,
    )
  }

  return record
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string in ${CONFIG_FILE_NAME}`)
  }
  return value
}

function expectStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array of strings in ${CONFIG_FILE_NAME}`)
  }
  return value.map((entry, index) => expectString(entry, `${path}[${index}]`))
}

function assertCountryCode(code: string, path: string): void {
  if (!COUNTRY_CODE_PATTERN.test(code.trim().toLowerCase())) {
    throw new Error(`${path} must be a two-letter ISO 3166-1 code such as "ch" or "fr", got "${code}"`)
  }
}

/** Reads the optional per-file overrides of a config object. */
function parseFileOverrides(value: unknown, path: string): Partial<FileSettings> | undefined {
  if (value === undefined) return undefined

  const record = expectRecord(value, path, FILE_KEYS)
  const overrides: Partial<FileSettings> = {}

  if (record.file !== undefined) overrides.file = expectString(record.file, `${path}.file`)
  if (record.id !== undefined) overrides.id = expectString(record.id, `${path}.id`)
  if (record.description !== undefined) {
    overrides.description = expectString(record.description, `${path}.description`)
  }
  if (record.tags !== undefined) overrides.tags = expectStringArray(record.tags, `${path}.tags`)

  return overrides
}

/** Validates a parsed config file; throws with the offending JSON path on typos. */
export function parseSpeedCamerasConfig(raw: unknown, path = 'config'): SpeedCamerasConfig {
  const root = expectRecord(raw, path, ROOT_KEYS)

  const urlBase =
    root.urlBase === undefined ? DEFAULT_URL_BASE : expectString(root.urlBase, `${path}.urlBase`)

  let defaults = BUILT_IN_FILE_SETTINGS
  if (root.defaults !== undefined) {
    const record = expectRecord(root.defaults, `${path}.defaults`, ['cameras', 'areas'])
    defaults = {
      cameras: {
        ...BUILT_IN_FILE_SETTINGS.cameras,
        ...parseFileOverrides(record.cameras, `${path}.defaults.cameras`),
      },
      areas: {
        ...BUILT_IN_FILE_SETTINGS.areas,
        ...parseFileOverrides(record.areas, `${path}.defaults.areas`),
      },
    }
  }

  if (!Array.isArray(root.countries) || root.countries.length === 0) {
    throw new Error(`${path}.countries must list at least one country code in ${CONFIG_FILE_NAME}`)
  }

  const countries = root.countries.map((entry, index) => {
    const entryPath = `${path}.countries[${index}]`

    // Shorthand: "fr" instead of { "code": "fr" }.
    if (typeof entry === 'string') {
      assertCountryCode(entry, entryPath)
      return { code: entry }
    }

    const record = expectRecord(entry, entryPath, COUNTRY_KEYS)
    const code = expectString(record.code, `${entryPath}.code`)
    assertCountryCode(code, `${entryPath}.code`)
    const cameras = parseFileOverrides(record.cameras, `${entryPath}.cameras`)
    const areas = parseFileOverrides(record.areas, `${entryPath}.areas`)

    return {
      code,
      ...(record.name === undefined ? {} : { name: expectString(record.name, `${entryPath}.name`) }),
      ...(record.tag === undefined ? {} : { tag: expectString(record.tag, `${entryPath}.tag`) }),
      ...(cameras === undefined ? {} : { cameras }),
      ...(areas === undefined ? {} : { areas }),
    }
  })

  const duplicates = countries
    .map((country) => country.code.trim().toLowerCase())
    .filter((code, index, codes) => codes.indexOf(code) !== index)
  if (duplicates.length > 0) {
    throw new Error(`${path}.countries lists ${duplicates.join(', ')} more than once`)
  }

  return { urlBase, defaults, countries }
}

export async function loadSpeedCamerasConfig(
  explicitPath: string | undefined = process.env.CONFIG_PATH,
): Promise<SpeedCamerasConfig> {
  const configPath = resolve(REPO_ROOT, explicitPath?.trim() || CONFIG_FILE_NAME)

  try {
    return parseSpeedCamerasConfig(JSON.parse(await readFile(configPath, 'utf8')) as unknown)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error

    if (explicitPath?.trim()) {
      throw new Error(`config file not found: ${configPath}`)
    }

    console.warn(`warning: ${CONFIG_FILE_NAME} not found, falling back to ${DEFAULT_COUNTRY_CODE}`)
    return { urlBase: DEFAULT_URL_BASE, defaults: BUILT_IN_FILE_SETTINGS, countries: [{ code: DEFAULT_COUNTRY_CODE }] }
  }
}

export function createCountryConfig(
  entry: SpeedCamerasConfig['countries'][number],
  config: Pick<SpeedCamerasConfig, 'defaults'>,
): CountryConfig {
  const code = entry.code.trim().toLowerCase()
  if (!COUNTRY_CODE_PATTERN.test(code)) {
    throw new Error(
      `invalid country code "${entry.code}": expected a two-letter ISO 3166-1 code such as "ch" or "fr"`,
    )
  }

  const isoCode = code.toUpperCase()
  const derivedName = entry.name !== undefined && entry.tag !== undefined ? '' : describeCountry(isoCode)
  const name = entry.name ?? derivedName
  const countryTag = entry.tag !== undefined ? slugifyTag(entry.tag) : slugifyTag(derivedName)
  const tokens = { code, CODE: isoCode, country: name, countryTag }

  return {
    code,
    isoCode,
    name,
    countryTag,
    cameraQuery: buildCameraQuery(isoCode),
    areaQuery: buildAreaQuery(isoCode),
    cameras: expandFileSettings({ ...config.defaults.cameras, ...entry.cameras }, tokens),
    areas: expandFileSettings({ ...config.defaults.areas, ...entry.areas }, tokens),
  }
}

/**
 * Resolves the countries to export: the requested codes when given, otherwise
 * everything listed in the config file. Codes that are not configured are
 * fetched ad hoc with the default settings.
 */
export function createCountryConfigs(config: SpeedCamerasConfig, requestedCodes?: string[]): CountryConfig[] {
  if (requestedCodes && requestedCodes.length > 0) {
    return requestedCodes.map((requested) => {
      const code = requested.trim().toLowerCase()
      const configured = config.countries.find((entry) => entry.code.trim().toLowerCase() === code)
      return createCountryConfig(configured ?? { code }, config)
    })
  }

  return config.countries.map((entry) => createCountryConfig(entry, config))
}

/** Country code from the first CLI argument, then `COUNTRY_CODE`; undefined means "all configured". */
export function resolveCountryCode(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return argv.find((value) => value.trim().length > 0 && !value.startsWith('-')) ?? env.COUNTRY_CODE
}

export function resolveUrlBase(base: string | undefined = process.env.UPDATE_BASE_URL): string {
  const trimmed = base?.trim()
  return (trimmed && trimmed.length > 0 ? trimmed : DEFAULT_URL_BASE).replace(/\/+$/, '')
}

export function buildFileUrl(fileName: string, base?: string): string {
  return `${resolveUrlBase(base)}/${fileName}`
}

/**
 * `OVERPASS_URL` may hold a single endpoint (tried before the defaults) or a
 * comma-separated list that replaces them entirely.
 */
export function getMirrors(override: string | undefined): string[] {
  const entries = (override ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  if (entries.length === 0) return [...DEFAULT_MIRRORS]
  if (entries.length > 1) return entries

  const [first] = entries
  if (!first) return [...DEFAULT_MIRRORS]
  return [first, ...DEFAULT_MIRRORS.filter((mirror) => mirror !== first)]
}

async function requestOverpass(url: string, query: string): Promise<OverpassPayload> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
  })

  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)

  const text = await response.text()
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 140)

  let payload: OverpassResponse
  try {
    payload = JSON.parse(text) as OverpassResponse
  } catch {
    // Overloaded mirrors answer with HTML gateway pages, which must not be parsed.
    throw new Error(`non-JSON response: ${snippet}`)
  }

  if (payload.remark) throw new Error(`Overpass remark: ${payload.remark}`)
  if (!Array.isArray(payload.elements)) throw new Error(`response has no elements array: ${snippet}`)

  const timestamp = payload.osm3s?.timestamp_osm_base
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
    throw new Error('response is missing a usable osm3s.timestamp_osm_base')
  }

  return { elements: payload.elements, timestamp }
}

async function fetchSnapshot(
  name: string,
  query: string,
  override: string | undefined,
): Promise<Snapshot> {
  const mirrors = getMirrors(override)
  const failures: string[] = []

  for (const [index, mirror] of mirrors.entries()) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MIRROR; attempt += 1) {
      const isLastAttempt = index === mirrors.length - 1 && attempt === ATTEMPTS_PER_MIRROR

      try {
        const { elements, timestamp } = await requestOverpass(mirror, query)

        console.log(`[${name}] ${mirror} (attempt ${attempt}) -> ${elements.length} elements, OSM snapshot ${timestamp}`)
        return { elements, mirror, timestamp }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${mirror} attempt ${attempt}: ${message}`)
        console.warn(`[${name}] ${mirror} attempt ${attempt} failed: ${message}`)
        if (!isLastAttempt) await sleep(RETRY_DELAY_MS)
      }
    }
  }

  throw new Error(`[${name}] every Overpass mirror failed:\n  ${failures.join('\n  ')}`)
}

function roundCoordinate(value: number): number {
  return Number(value.toFixed(COORDINATE_PRECISION))
}

function toPosition(point: OverpassCoordinates): Position {
  return [roundCoordinate(point.lon), roundCoordinate(point.lat)]
}

function memberPosition(member: OverpassMember): Position | null {
  if (member.lat === undefined || member.lon === undefined) return null
  return toPosition({ lat: member.lat, lon: member.lon })
}

function dedupeConsecutive(positions: Position[]): Position[] {
  const deduped: Position[] = []

  for (const position of positions) {
    const previous = deduped[deduped.length - 1]
    if (!previous || position[0] !== previous[0] || position[1] !== previous[1]) deduped.push(position)
  }

  return deduped
}

export function parseMaxspeed(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const match = MAXSPEED_PATTERN.exec(raw.trim())
  const digits = match?.[1]
  if (digits === undefined) return undefined
  const value = Number(digits.replace(',', '.'))
  return Number.isFinite(value) ? value : undefined
}

function buildProperties(
  label: string,
  osmType: DatapackProperties['osmType'],
  osmId: number,
  rawMaxspeed: string | undefined,
): DatapackProperties {
  const speed = parseMaxspeed(rawMaxspeed)
  // Key order matters for stable diffs: label, speed | maxspeed, osmType, osmId.
  const speedProperties =
    speed !== undefined ? { speed } : rawMaxspeed !== undefined ? { maxspeed: rawMaxspeed } : {}

  return { label, ...speedProperties, osmType, osmId }
}

function buildCameraFeatures(elements: OverpassElement[], warnings: string[]): DatapackFeature[] {
  const features: DatapackFeature[] = []

  for (const element of elements) {
    const { lat, lon } = element

    if (element.type !== 'node' || lat === undefined || lon === undefined) {
      warnings.push(`skipped camera element ${element.type}/${element.id}: not a node with coordinates`)
      continue
    }

    features.push({
      type: 'Feature',
      properties: buildProperties(CAMERA_LABEL, 'node', element.id, element.tags?.maxspeed),
      geometry: { type: 'Point', coordinates: toPosition({ lat, lon }) },
    })
  }

  features.sort((left, right) => left.properties.osmId - right.properties.osmId)
  return features
}

/** Real section geometry from way members, preferring members with the `section` role. */
function sectionLineStrings(members: OverpassMember[]): Position[][] {
  const ways = members.filter((member) => member.type === 'way' && (member.geometry?.length ?? 0) >= 2)
  const sections = ways.filter((member) => member.role === 'section')
  const source = sections.length > 0 ? sections : ways

  return source
    .map((member) => dedupeConsecutive((member.geometry ?? []).map(toPosition)))
    .filter((positions) => positions.length >= 2)
}

function nodePositionsByRole(members: OverpassMember[]): Map<string, Position[]> {
  const positionsByRole = new Map<string, Position[]>()

  for (const member of members) {
    if (member.type !== 'node') continue
    const position = memberPosition(member)
    if (!position) continue

    const role = member.role ?? ''
    const positions = positionsByRole.get(role)
    if (positions) positions.push(position)
    else positionsByRole.set(role, [position])
  }

  return positionsByRole
}

function firstNodePosition(members: OverpassMember[]): Position | null {
  for (const member of members) {
    if (member.type !== 'node') continue
    const position = memberPosition(member)
    if (position) return position
  }
  return null
}

/**
 * Enforcement relations in Switzerland are usually mapped with `from`/`to`
 * detector nodes and a `device` node rather than with section ways, so the
 * measured section is rebuilt as a straight line between the detectors. The
 * device node is only used when a detector is missing, since it often sits off
 * the axis of travel.
 */
export function buildAreaGeometry(element: OverpassElement): DatapackGeometry | null {
  const members = element.members ?? []

  const [firstLine, ...otherLines] = sectionLineStrings(members)
  if (firstLine && otherLines.length === 0) return { type: 'LineString', coordinates: firstLine }
  if (firstLine) return { type: 'MultiLineString', coordinates: [firstLine, ...otherLines] }

  const positionsByRole = nodePositionsByRole(members)
  const at = (role: string) => (positionsByRole.get(role) ?? []).slice(0, 1)

  const detectors = dedupeConsecutive([...at('from'), ...at('to')])
  if (detectors.length >= 2) return { type: 'LineString', coordinates: detectors }

  const fallback = dedupeConsecutive(NODE_ROLE_ORDER.flatMap(at))
  if (fallback.length >= 2) return { type: 'LineString', coordinates: fallback }

  const single = fallback[0] ?? detectors[0] ?? firstNodePosition(members)
  if (single) return { type: 'Point', coordinates: single }

  return null
}

function buildAreaFeatures(elements: OverpassElement[], warnings: string[]): DatapackFeature[] {
  const features: DatapackFeature[] = []

  for (const element of elements) {
    if (element.type !== 'relation') {
      warnings.push(`skipped enforcement element ${element.type}/${element.id}: not a relation`)
      continue
    }

    const geometry = buildAreaGeometry(element)
    if (!geometry) {
      warnings.push(`skipped enforcement relation ${element.id}: no usable geometry`)
      continue
    }

    features.push({
      type: 'Feature',
      properties: buildProperties(AREA_LABEL, 'relation', element.id, element.tags?.maxspeed),
      geometry,
    })
  }

  features.sort((left, right) => left.properties.osmId - right.properties.osmId)
  return features
}

function buildDatapack(
  settings: FileSettings,
  version: string,
  features: DatapackFeature[],
  urlBase: string,
): DatapackFile {
  return {
    id: settings.id,
    version,
    description: settings.description,
    url: buildFileUrl(settings.file, urlBase),
    tags: settings.tags,
    data: { type: 'FeatureCollection', features },
  }
}

/** Both files of a country carry the oldest snapshot of that country so they describe the same vintage. */
export function snapshotVersion(timestamps: string[]): string {
  const oldest = timestamps
    .map((timestamp) => Date.parse(timestamp))
    .filter((value) => !Number.isNaN(value))
    .reduce((earliest, value) => (value < earliest ? value : earliest), Number.POSITIVE_INFINITY)

  if (!Number.isFinite(oldest)) throw new Error('no usable OSM snapshot timestamp')
  return new Date(oldest).toISOString().slice(0, 10)
}

function warnAboutStaleSnapshots(label: string, timestamps: string[]): void {
  const maxAgeMs = MAX_SNAPSHOT_AGE_DAYS * 24 * 60 * 60 * 1000

  for (const timestamp of timestamps) {
    const age = Date.now() - Date.parse(timestamp)
    if (Number.isFinite(age) && age > maxAgeMs) {
      console.warn(
        `warning: [${label}] mirror served a snapshot from ${timestamp}, ` +
          `which is ${Math.round(age / 86_400_000)} days old`,
      )
    }
  }
}

async function writeDatapacks(files: { fileName: string; contents: DatapackFile }[]): Promise<string[]> {
  const staged: { target: string; temporary: string }[] = []

  try {
    for (const file of files) {
      const target = resolve(REPO_ROOT, file.fileName)
      const temporary = `${target}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(file.contents, null, 2)}\n`, 'utf8')
      staged.push({ target, temporary })
    }

    for (const { target, temporary } of staged) await rename(temporary, target)
  } catch (error) {
    await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true })))
    throw error
  }

  return staged.map(({ target }) => target)
}

function countGeometryTypes(features: DatapackFeature[]): Record<DatapackGeometry['type'], number> {
  const counts: Record<DatapackGeometry['type'], number> = { Point: 0, LineString: 0, MultiLineString: 0 }
  for (const feature of features) counts[feature.geometry.type] += 1
  return counts
}

function describeFeatures(features: DatapackFeature[]): string {
  const geometryCounts = countGeometryTypes(features)
  const withSpeed = features.filter((feature) => feature.properties.speed !== undefined).length
  const withRawMaxspeed = features.filter((feature) => feature.properties.maxspeed !== undefined).length
  const shapes = Object.entries(geometryCounts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ')

  return `${features.length} features (${shapes}) | speed known: ${withSpeed}, non-numeric maxspeed: ${withRawMaxspeed}`
}

async function fetchCountry(
  country: CountryConfig,
  override: string | undefined,
): Promise<CountrySnapshot> {
  const warnings: string[] = []
  const label = `${country.name} (${country.isoCode})`

  const cameras = await fetchSnapshot(`${label} cameras`, country.cameraQuery, override)
  const areas = await fetchSnapshot(`${label} areas`, country.areaQuery, override)

  warnAboutStaleSnapshots(label, [cameras.timestamp, areas.timestamp])

  const cameraFeatures = buildCameraFeatures(cameras.elements, warnings)
  const areaFeatures = buildAreaFeatures(areas.elements, warnings)

  for (const warning of warnings) console.warn(`warning: [${label}] ${warning}`)

  if (cameraFeatures.length === 0) {
    throw new Error(
      `the camera query returned no usable features for ${country.isoCode}` +
        ' (is the country code right?), nothing was written',
    )
  }
  if (areaFeatures.length === 0) {
    throw new Error(
      `the enforcement query returned no usable features for ${country.isoCode}` +
        ' (is the country code right?), nothing was written',
    )
  }

  return {
    country,
    version: snapshotVersion([cameras.timestamp, areas.timestamp]),
    cameras,
    areas,
    warnings,
    cameraFeatures,
    areaFeatures,
  }
}

async function main(): Promise<void> {
  const override = process.env.OVERPASS_URL
  const urlBase = resolveUrlBase()
  const config = await loadSpeedCamerasConfig()
  const requested = resolveCountryCode()
  const countries = createCountryConfigs(config, requested ? [requested] : undefined)

  console.log(
    `countries: ${countries.map((country) => `${country.name} (${country.isoCode})`).join(', ')}` +
      `${requested ? ` [requested: ${requested.toLowerCase()}]` : ' [from config]'}`,
  )
  console.log(`url base: ${urlBase}`)
  console.log('')

  const results: CountrySnapshot[] = []
  for (const country of countries) {
    results.push(await fetchCountry(country, override))
  }

  const files = results.flatMap((result) => [
    {
      fileName: result.country.cameras.file,
      contents: buildDatapack(result.country.cameras, result.version, result.cameraFeatures, urlBase),
    },
    {
      fileName: result.country.areas.file,
      contents: buildDatapack(result.country.areas, result.version, result.areaFeatures, urlBase),
    },
  ])

  const written = await writeDatapacks(files)

  console.log('')
  for (const result of results) {
    const { country, cameras, areas } = result

    console.log(`${country.name} (${country.isoCode}) — version ${result.version}`)
    console.log(`  snapshots: cameras ${cameras.timestamp} via ${cameras.mirror}`)
    console.log(`             areas   ${areas.timestamp} via ${areas.mirror}`)
    console.log(`  cameras: ${describeFeatures(result.cameraFeatures)} -> ${country.cameras.file}`)
    console.log(`  areas:   ${describeFeatures(result.areaFeatures)} -> ${country.areas.file}`)
  }
  console.log(`wrote ${written.length} files: ${written.map((path) => path.split(/[\\/]/).pop()).join(', ')}`)
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
