'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const { unzipSync } = require('fflate');
const { transit_realtime } = require('gtfs-realtime-bindings');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CACHE_DIR = path.join(ROOT, '.cache');
const STATIC_CACHE_FILE = path.join(CACHE_DIR, 'lviv-static.zip');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';

const FEED_URLS = {
  static: process.env.LVIV_GTFS_STATIC || 'https://track.ua-gis.com/gtfs/lviv/static.zip',
  positions: process.env.LVIV_GTFS_POSITIONS || 'https://track.ua-gis.com/gtfs/lviv/vehicle_position',
  updates: process.env.LVIV_GTFS_UPDATES || 'https://track.ua-gis.com/gtfs/lviv/trip_updates',
  alerts: process.env.LVIV_GTFS_ALERTS || 'https://track.ua-gis.com/gtfs/lviv/alerts'
};

const REVERSE_GEOCODER_URL = process.env.LVIV_REVERSE_GEOCODER || 'https://nominatim.openstreetmap.org/reverse';

const TRANSIT_SOURCE = {
  name: 'Відкриті дані Львівської міської ради / ЛьвівАвтодор',
  staticUrl: FEED_URLS.static,
  realtimeUrl: FEED_URLS.positions,
  license: 'CC BY 4.0',
  attribution: 'Дані: Львівська міська рада / ЛьвівАвтодор, відкриті дані'
};

const WALK_SPEED_M_PER_MIN = 75;
const DEFAULT_MAX_RADIUS_M = 650;
const DEFAULT_HORIZON_SECONDS = 8 * 60 * 60;
const MAX_LEGS = 3;
const TRANSFER_BUFFER_SECONDS = 3 * 60;
const MAX_FRONTIER_LABELS = 260;
const MAX_CANDIDATES = 80;
const LIVE_CACHE_MS = 12_000;
const STATIC_CACHE_MS = 6 * 60 * 60 * 1000;

let transitPromise;
let transitData;
let livePromise;
let liveCache = { at: 0, vehicles: [], updates: new Map(), alerts: [] };
let dateEventCache = new Map();
const reverseCache = new Map();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function sendError(res, status, message, details) {
  sendJson(res, status, { error: message, ...(details ? { details } : {}) });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function numberValue(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toSeconds(value) {
  if (value == null || value === '') return null;
  const parts = String(value).trim().split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  const hours = parts[0] || 0;
  const minutes = parts[1] || 0;
  const seconds = parts[2] || 0;
  return hours * 3600 + minutes * 60 + seconds;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatClock(seconds) {
  if (seconds == null) return '—';
  const normalized = ((Math.round(seconds) % 86400) + 86400) % 86400;
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  return `${pad(hours)}:${pad(minutes)}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds / 60));
  if (total < 60) return `${total} хв`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes ? `${hours} год ${minutes} хв` : `${hours} год`;
}

function dateKeyFromDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kiev',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateKeyOffset(dateKey, offsetDays) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return date.toISOString().slice(0, 10);
}

function localTimeFromDate(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kiev',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return toSeconds(`${values.hour}:${values.minute}:${values.second}`) || 0;
}

function localDateTimeFromInput(input, now = new Date()) {
  if (!input) {
    return { dateKey: dateKeyFromDate(now), seconds: localTimeFromDate(now), epochMs: now.getTime() };
  }

  const value = String(input).trim();
  if (/^\d{2}:\d{2}$/.test(value)) {
    const seconds = toSeconds(`${value}:00`);
    const nowSeconds = localTimeFromDate(now);
    const todayKey = dateKeyFromDate(now);
    // A time-only input means the next occurrence of that time.
    const dateKey = seconds < nowSeconds - 60 ? dateKeyOffset(todayKey, 1) : todayKey;
    return { dateKey, seconds, epochMs: now.getTime() + (seconds - nowSeconds) * 1000 };
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return {
      dateKey: dateKeyFromDate(parsed),
      seconds: localTimeFromDate(parsed),
      epochMs: parsed.getTime()
    };
  }

  return { dateKey: dateKeyFromDate(now), seconds: localTimeFromDate(now), epochMs: now.getTime() };
}

function epochToLocalSeconds(epochSeconds) {
  if (epochSeconds == null) return null;
  return localTimeFromDate(new Date(epochSeconds * 1000));
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const radius = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeText(value) {
  return String(value || '')
    .toLocaleLowerCase('uk-UA')
    .replace(/[’'`ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function repairMixedEncoding(bytes) {
  // The Lviv feed contains mostly Windows-1251 with a few UTF-8 fields.
  // Pick the interpretation with the fewest replacement characters.
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
  const windows = new TextDecoder('windows-1251', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
  const replacementCount = (text) => (text.match(/�/g) || []).length;
  return replacementCount(utf8) <= replacementCount(windows) ? utf8 : windows;
}

function* csvRows(text) {
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((value) => value.length > 0)) yield row;
      row = [];
      i += 1;
      continue;
    }

    field += char;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.length > 0)) yield row;
  }
}

function objectRows(text) {
  const iterator = csvRows(text);
  const first = iterator.next();
  if (first.done) return [];
  const headers = first.value;
  return (function* () {
    for (const row of iterator) {
      if (row.length === 1 && row[0] === '') continue;
      const item = {};
      for (let index = 0; index < headers.length; index += 1) item[headers[index]] = row[index] || '';
      yield item;
    }
  })();
}

async function fetchBuffer(url, timeoutMs = 25_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'LvivTransitPWA/0.1 (+https://opendata.city-adm.lviv.ua/)',
        Accept: '*/*'
      }
    });
    if (!response.ok) throw new Error(`Remote feed returned HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(5)}:${lon.toFixed(5)}`;
  const cached = reverseCache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value;
  const url = new URL(REVERSE_GEOCODER_URL);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('zoom', '18');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'uk');
  try {
    const payload = JSON.parse((await fetchBuffer(url, 8_000)).toString('utf8'));
    const address = payload.address || {};
    const name = payload.name || address.road || address.neighbourhood || address.suburb || 'Обрана точка на карті';
    const value = {
      name,
      displayName: payload.display_name || name,
      lat,
      lon,
      source: 'OpenStreetMap Nominatim'
    };
    reverseCache.set(key, { at: Date.now(), value });
    if (reverseCache.size > 100) reverseCache.delete(reverseCache.keys().next().value);
    return value;
  } catch (error) {
    return { name: 'Обрана точка на карті', displayName: 'Обрана точка на карті', lat, lon, source: 'fallback', warning: error.message };
  }
}

async function readOrFetchStaticZip() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  try {
    const stat = await fsp.stat(STATIC_CACHE_FILE);
    if (Date.now() - stat.mtimeMs < STATIC_CACHE_MS) {
      return { buffer: await fsp.readFile(STATIC_CACHE_FILE), cached: true, mtime: stat.mtime };
    }
  } catch {
    // No cache yet.
  }

  try {
    const buffer = await fetchBuffer(FEED_URLS.static, 60_000);
    await fsp.writeFile(STATIC_CACHE_FILE, buffer);
    return { buffer, cached: false, mtime: new Date() };
  } catch (error) {
    try {
      const stat = await fsp.stat(STATIC_CACHE_FILE);
      return { buffer: await fsp.readFile(STATIC_CACHE_FILE), cached: true, mtime: stat.mtime, warning: error.message };
    } catch {
      throw new Error(`Не вдалося завантажити GTFS: ${error.message}`);
    }
  }
}

function parseGtfs(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const read = (name) => {
    const bytes = files[name] || files[name.toLowerCase()];
    return bytes ? repairMixedEncoding(bytes) : '';
  };

  const stops = new Map();
  const stopList = [];
  for (const row of objectRows(read('stops.txt'))) {
    const stop = {
      id: row.stop_id,
      code: row.stop_code || '',
      name: row.stop_name || row.stop_id,
      desc: row.stop_desc || '',
      lat: numberValue(row.stop_lat, NaN),
      lon: numberValue(row.stop_lon, NaN)
    };
    if (!stop.id) continue;
    stops.set(stop.id, stop);
    stopList.push(stop);
  }

  const routes = new Map();
  for (const row of objectRows(read('routes.txt'))) {
    if (!row.route_id) continue;
    routes.set(row.route_id, {
      id: row.route_id,
      shortName: row.route_short_name || row.route_id,
      longName: row.route_long_name || '',
      type: numberValue(row.route_type, 3),
      color: row.route_color || '2563eb'
    });
  }

  const trips = new Map();
  for (const row of objectRows(read('trips.txt'))) {
    if (!row.trip_id) continue;
    trips.set(row.trip_id, {
      id: row.trip_id,
      routeId: row.route_id,
      serviceId: row.service_id,
      directionId: row.direction_id || '0',
      headsign: row.trip_headsign || '',
      shapeId: row.shape_id || '',
      stopTimes: []
    });
  }

  for (const row of objectRows(read('stop_times.txt'))) {
    const trip = trips.get(row.trip_id);
    if (!trip) continue;
    const arrival = toSeconds(row.arrival_time);
    const departure = toSeconds(row.departure_time);
    trip.stopTimes.push({
      stopId: row.stop_id,
      sequence: numberValue(row.stop_sequence, trip.stopTimes.length + 1),
      arrival: arrival == null ? departure : arrival,
      departure: departure == null ? arrival : departure
    });
  }
  for (const trip of trips.values()) {
    trip.stopTimes.sort((a, b) => a.sequence - b.sequence);
    trip.stopTimes = trip.stopTimes.filter((stopTime) => stopTime.stopId && stopTime.arrival != null);
  }

  const calendar = new Map();
  for (const row of objectRows(read('calendar.txt'))) {
    if (!row.service_id) continue;
    calendar.set(row.service_id, {
      start: row.start_date || '19700101',
      end: row.end_date || '99991231',
      days: [
        row.monday === '1', row.tuesday === '1', row.wednesday === '1', row.thursday === '1',
        row.friday === '1', row.saturday === '1', row.sunday === '1'
      ]
    });
  }

  const calendarDates = new Map();
  for (const row of objectRows(read('calendar_dates.txt'))) {
    if (!row.service_id || !row.date) continue;
    const key = row.date.replaceAll('-', '');
    if (!calendarDates.has(key)) calendarDates.set(key, new Map());
    calendarDates.get(key).set(row.service_id, numberValue(row.exception_type, 1));
  }

  const eventsByStop = new Map();
  for (const trip of trips.values()) {
    for (let index = 0; index < trip.stopTimes.length; index += 1) {
      const stopTime = trip.stopTimes[index];
      if (!eventsByStop.has(stopTime.stopId)) eventsByStop.set(stopTime.stopId, []);
      eventsByStop.get(stopTime.stopId).push({
        trip,
        index,
        time: stopTime.departure ?? stopTime.arrival
      });
    }
  }
  for (const events of eventsByStop.values()) events.sort((a, b) => a.time - b.time);

  const landmarks = createLandmarks(stopList);
  return {
    stops,
    stopList,
    routes,
    trips,
    calendar,
    calendarDates,
    eventsByStop,
    landmarks,
    loadedAt: new Date().toISOString(),
    source: TRANSIT_SOURCE
  };
}

function createLandmarks(stopList) {
  const findByName = (patterns) => {
    const normalizedPatterns = patterns.map(normalizeText);
    return stopList.filter((stop) => {
      const text = normalizeText(`${stop.name} ${stop.desc}`);
      return normalizedPatterns.some((pattern) => text.includes(pattern));
    });
  };
  const nearest = (lat, lon, maxDistance = 1200) => stopList
    .map((stop) => ({ stop, distance: haversineMeters(lat, lon, stop.lat, stop.lon) }))
    .filter((item) => item.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .map((item) => item.stop);

  const victoria = findByName(['вікторія гарденс', 'victoria gardens', 'вiкторія гарденс']);
  const santa = findByName(['санта-барбара', 'санта барбара', 'santa barbara']);
  const railway = findByName(['залізничний вокзал']);
  const university = findByName(['університет']);

  return [
    {
      id: 'landmark:victoria-gardens',
      name: 'Victoria Gardens / Вікторія Гарденс',
      shortName: 'Вікторія Гарденс',
      type: 'place',
      lat: 49.80598,
      lon: 23.98002,
      stopIds: (victoria.length ? victoria : nearest(49.80598, 23.98002)).map((stop) => stop.id)
    },
    {
      id: 'landmark:santa-barbara',
      name: 'Санта Барбара',
      shortName: 'Санта Барбара',
      type: 'place',
      lat: 49.7855,
      lon: 24.0591,
      stopIds: (santa.length ? santa : nearest(49.7855, 24.0591)).map((stop) => stop.id)
    },
    {
      id: 'landmark:railway-station',
      name: 'Залізничний вокзал',
      shortName: 'Залізничний вокзал',
      type: 'place',
      lat: 49.8357,
      lon: 24.0067,
      stopIds: (railway.length ? railway : nearest(49.8357, 24.0067)).map((stop) => stop.id)
    },
    {
      id: 'landmark:university',
      name: 'Університет',
      shortName: 'Університет',
      type: 'place',
      lat: 49.8407,
      lon: 24.0225,
      stopIds: (university.length ? university : nearest(49.8407, 24.0225)).map((stop) => stop.id)
    }
  ];
}

async function getTransit() {
  if (transitData) return transitData;
  if (!transitPromise) {
    transitPromise = (async () => {
      const loaded = await readOrFetchStaticZip();
      transitData = parseGtfs(loaded.buffer);
      dateEventCache = new Map();
      if (loaded.warning) transitData.warning = loaded.warning;
      console.log(`GTFS loaded: ${transitData.stopList.length} stops, ${transitData.trips.size} trips${loaded.cached ? ' (cache)' : ''}`);
      return transitData;
    })().catch((error) => {
      transitPromise = undefined;
      throw error;
    });
  }
  return transitPromise;
}

function serviceIsActive(data, serviceId, dateKey) {
  const date = dateKey.replaceAll('-', '');
  const exceptions = data.calendarDates.get(date);
  if (exceptions && exceptions.has(serviceId)) return exceptions.get(serviceId) === 1;
  const service = data.calendar.get(serviceId);
  if (!service) return true;
  if (date < service.start || date > service.end) return false;
  const [year, month, day] = dateKey.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return service.days[(weekday + 6) % 7];
}

function getEventsForDate(data, dateKey) {
  if (dateEventCache.has(dateKey)) return dateEventCache.get(dateKey);
  const result = new Map();
  for (const [stopId, events] of data.eventsByStop) {
    const active = [];
    for (const event of events) {
      if (serviceIsActive(data, event.trip.serviceId, dateKey)) active.push(event);
    }
    if (active.length) result.set(stopId, active);
  }
  if (dateEventCache.size > 3) dateEventCache.delete(dateEventCache.keys().next().value);
  dateEventCache.set(dateKey, result);
  return result;
}

function parsePlaceInput(data, raw, fallbackLat, fallbackLon) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const landmark = data.landmarks.find((item) => item.id === value || normalizeText(item.name) === normalizeText(value));
  if (landmark) return landmark;

  if (/^stop:/i.test(value)) {
    const stopId = value.slice(5);
    const stop = data.stops.get(stopId);
    return stop ? { ...stop, type: 'stop', stopIds: [stop.id] } : null;
  }

  const coordinateValue = /^coord:/i.test(value) ? value.slice(6) : value;
  const coords = coordinateValue.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (coords) {
    const lat = Number(coords[1]);
    const lon = Number(coords[2]);
    const nearby = data.stopList
      .map((stop) => ({ stop, distance: haversineMeters(lat, lon, stop.lat, stop.lon) }))
      .filter((item) => item.distance <= 1500)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8)
      .map((item) => item.stop);
    return { id: `coord:${lat},${lon}`, name: 'Моє місце', type: 'coordinate', lat, lon, stopIds: nearby.map((stop) => stop.id) };
  }

  const normalized = normalizeText(value);
  const matchingStops = data.stopList
    .map((stop) => {
      const name = normalizeText(stop.name);
      const desc = normalizeText(stop.desc);
      let score = 0;
      if (name === normalized) score += 100;
      if (name.includes(normalized)) score += 50;
      if (desc.includes(normalized)) score += 25;
      if (normalized.includes(name) && name.length > 3) score += 20;
      return { stop, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((item) => item.stop);

  if (matchingStops.length) {
    return {
      id: `search:${matchingStops[0].id}`,
      name: matchingStops[0].name,
      type: 'stop-search',
      lat: fallbackLat ?? matchingStops[0].lat,
      lon: fallbackLon ?? matchingStops[0].lon,
      stopIds: matchingStops.map((stop) => stop.id)
    };
  }

  if (Number.isFinite(fallbackLat) && Number.isFinite(fallbackLon)) {
    const nearby = data.stopList
      .map((stop) => ({ stop, distance: haversineMeters(fallbackLat, fallbackLon, stop.lat, stop.lon) }))
      .filter((item) => item.distance <= 1500)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8)
      .map((item) => item.stop);
    if (nearby.length) return { id: 'coordinate', name: 'Найближчі зупинки', type: 'coordinate', lat: fallbackLat, lon: fallbackLon, stopIds: nearby.map((stop) => stop.id) };
  }
  return null;
}

function resolvePlace(data, raw, fallbackLat, fallbackLon) {
  const place = parsePlaceInput(data, raw, fallbackLat, fallbackLon);
  if (!place) return null;
  const stopIds = (place.stopIds || []).filter((id) => data.stops.has(id));
  if (!stopIds.length) return null;
  return { ...place, stopIds };
}

function nearbyStops(data, place, radius = DEFAULT_MAX_RADIUS_M) {
  if (!place) return [];
  if (place.stopIds && place.stopIds.length) {
    return place.stopIds.map((id) => data.stops.get(id)).filter(Boolean).map((stop) => ({
      stop,
      distance: haversineMeters(place.lat, place.lon, stop.lat, stop.lon)
    })).sort((a, b) => a.distance - b.distance);
  }
  return data.stopList
    .map((stop) => ({ stop, distance: haversineMeters(place.lat, place.lon, stop.lat, stop.lon) }))
    .filter((item) => item.distance <= radius)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 12);
}

function walkingSeconds(distanceMeters) {
  return Math.ceil(Math.max(0, distanceMeters) / WALK_SPEED_M_PER_MIN) * 60;
}

function makeLeg(data, trip, boardIndex, alightIndex, liveDelaySeconds = 0, dayOffset = 0) {
  const board = trip.stopTimes[boardIndex];
  const alight = trip.stopTimes[alightIndex];
  const route = data.routes.get(trip.routeId) || { shortName: trip.routeId, longName: '', type: 3 };
  const delay = Number.isFinite(liveDelaySeconds) ? liveDelaySeconds : 0;
  const offset = Number.isFinite(dayOffset) ? dayOffset : 0;
  return {
    tripId: trip.id,
    routeId: trip.routeId,
    route: route.shortName,
    routeLongName: route.longName,
    headsign: trip.headsign || route.longName,
    directionId: trip.directionId,
    boardStopId: board.stopId,
    boardStopName: data.stops.get(board.stopId)?.name || board.stopId,
    alightStopId: alight.stopId,
    alightStopName: data.stops.get(alight.stopId)?.name || alight.stopId,
    boardAt: (board.departure ?? board.arrival) + offset + delay,
    alightAt: (alight.arrival ?? alight.departure) + offset + delay,
    boardSequence: board.sequence,
    alightSequence: alight.sequence,
    color: route.color,
    liveDelaySeconds: delay,
    dayOffset
  };
}

function labelKey(label) {
  return label.stopId;
}

function makeCandidate(data, label, destination, finalLeg, departureInfo, preference) {
  const destinationWalk = walkingSeconds(label.finalWalkDistance || 0);
  const arrival = label.arrival + destinationWalk;
  const legs = label.legs;
  const firstLeg = legs[0];
  const wait = Math.max(0, firstLeg.boardAt - (departureInfo.seconds + (label.initialWalk || 0)));
  const transfers = Math.max(0, legs.length - 1);
  const arrivalClock = ((arrival % 86_400) + 86_400) % 86_400;
  const departureClock = ((departureInfo.seconds % 86_400) + 86_400) % 86_400;
  const arrivalDayOffset = finalLeg?.dayOffset || (arrivalClock < departureClock ? 86_400 : 0);
  const score = arrival + (preference === 'simple' ? transfers * 12 * 60 : transfers * 2 * 60);
  return {
    id: legs.map((leg) => `${leg.route}-${leg.boardAt}-${leg.alightAt}`).join('|'),
    score,
    departureAt: departureInfo.seconds,
    arrivalAt: arrival,
    duration: arrival - departureInfo.seconds,
    arrivalDayOffset,
    waitMinutes: Math.round(wait / 60),
    walkFromMinutes: Math.round((label.initialWalk || 0) / 60),
    walkToMinutes: Math.round(destinationWalk / 60),
    transfers,
    routeNames: [...new Set(legs.map((leg) => leg.route))],
    headsigns: [...new Set(legs.map((leg) => leg.headsign).filter(Boolean))],
    legs,
    destination: {
      name: destination.name,
      lat: destination.lat,
      lon: destination.lon
    },
    source: legs.some((leg) => leg.liveDelaySeconds) ? 'GTFS Schedule + live delay' : 'GTFS Schedule'
  };
}

function addFrontier(map, label) {
  const key = labelKey(label);
  const current = map.get(key);
  if (!current || label.arrival < current.arrival) map.set(key, label);
}

function sortAndLimitFrontier(map) {
  return [...map.values()].sort((a, b) => a.arrival - b.arrival).slice(0, MAX_FRONTIER_LABELS);
}

function planJourney(data, fromPlace, toPlace, departureInfo, preference = 'fastest') {
  const originCandidates = nearbyStops(data, fromPlace);
  const destinationCandidates = nearbyStops(data, toPlace);
  if (!originCandidates.length || !destinationCandidates.length) {
    return { options: [], originCandidates, destinationCandidates };
  }

  const destinationByStop = new Map(destinationCandidates.map((item) => [item.stop.id, item]));
  const liveDelays = new Map();
  for (const [tripId, update] of liveCache.updates || []) {
    if (update.delaySeconds == null) continue;
    const updateDate = String(update.serviceDate || '').replaceAll('-', '');
    const requestedDate = departureInfo.dateKey.replaceAll('-', '');
    if (updateDate && updateDate !== requestedDate) continue;
    liveDelays.set(tripId, update.delaySeconds);
  }
  const eventDates = [
    { dateKey: departureInfo.dateKey, offset: 0 },
    { dateKey: dateKeyOffset(departureInfo.dateKey, 1), offset: 86_400 }
  ];
  const eventMaps = eventDates.map(({ dateKey, offset }) => ({ dateKey, offset, events: getEventsForDate(data, dateKey) }));
  // At night, allow the first complete morning trip to be found instead of
  // showing an empty result merely because the final arrival is after 06:00.
  const searchHorizon = departureInfo.seconds >= 20 * 3600 ? 14 * 60 * 60 : DEFAULT_HORIZON_SECONDS;
  const horizonEnd = departureInfo.seconds + searchHorizon;

  let frontier = new Map();
  for (const origin of originCandidates.slice(0, 12)) {
    const walk = walkingSeconds(origin.distance);
    addFrontier(frontier, {
      stopId: origin.stop.id,
      arrival: departureInfo.seconds + walk,
      initialWalk: walk,
      legs: [],
      finalWalkDistance: Infinity
    });
  }

  const candidates = [];
  const seenCandidates = new Set();
  const addCandidate = (label, leg) => {
    const destinationInfo = destinationByStop.get(leg.alightStopId);
    if (!destinationInfo) return;
    const candidate = makeCandidate(data, { ...label, finalWalkDistance: destinationInfo.distance }, toPlace, leg, departureInfo, preference);
    if (seenCandidates.has(candidate.id)) return;
    seenCandidates.add(candidate.id);
    candidates.push(candidate);
  };

  for (let legNumber = 0; legNumber < MAX_LEGS; legNumber += 1) {
    const next = new Map();
    const labels = sortAndLimitFrontier(frontier);
    for (const label of labels) {
      const isFirstLeg = label.legs.length === 0;
      const minimumBoardTime = label.arrival + (isFirstLeg ? 0 : TRANSFER_BUFFER_SECONDS);
      for (const dateInfo of eventMaps) {
        const events = dateInfo.events.get(label.stopId) || [];
        for (const event of events) {
          const trip = event.trip;
          const liveDelay = dateInfo.offset === 0 ? (liveDelays.get(trip.id) || 0) : 0;
          const eventTime = event.time + dateInfo.offset + liveDelay;
          if (eventTime < minimumBoardTime) continue;
          if (eventTime > horizonEnd) continue;
          if (!trip.stopTimes.length) continue;
          for (let alightIndex = event.index + 1; alightIndex < trip.stopTimes.length; alightIndex += 1) {
            const alight = trip.stopTimes[alightIndex];
            const alightTime = alight.arrival == null ? null : alight.arrival + dateInfo.offset + liveDelay;
            if (alightTime == null || alightTime < label.arrival) continue;
            if (alightTime > horizonEnd) break;
            const newLeg = makeLeg(data, trip, event.index, alightIndex, liveDelay, dateInfo.offset);
            const newLabel = {
              stopId: alight.stopId,
              arrival: alightTime,
              initialWalk: label.initialWalk,
              legs: [...label.legs, newLeg],
              finalWalkDistance: Infinity
            };
            addCandidate(newLabel, newLeg);
            addFrontier(next, newLabel);
          }
        }
      }
    }
    frontier = next;
    if (!frontier.size) break;
  }

  const ranked = candidates
    .sort((a, b) => a.score - b.score || a.arrivalAt - b.arrivalAt)
    .slice(0, 12);

  // Keep alternatives that start at meaningfully different times or use different routes.
  const selected = [];
  for (const candidate of ranked) {
    const tooSimilar = selected.some((existing) =>
      existing.routeNames.join('|') === candidate.routeNames.join('|')
      && Math.abs(existing.arrivalAt - candidate.arrivalAt) < 8 * 60
    );
    if (!tooSimilar) selected.push(candidate);
    if (selected.length >= 6) break;
  }

  return {
    options: selected.length ? selected : ranked.slice(0, 3),
    searchedAt: new Date().toISOString(),
    horizonEnd,
    originCandidates: originCandidates.slice(0, 8).map((item) => publicStop(data, item.stop, item.distance)),
    destinationCandidates: destinationCandidates.slice(0, 8).map((item) => publicStop(data, item.stop, item.distance))
  };
}

function publicStop(data, stop, distance) {
  const routes = [...new Set((data.eventsByStop.get(stop.id) || [])
    .map((event) => data.routes.get(event.trip.routeId)?.shortName)
    .filter(Boolean))].slice(0, 12);
  return {
    id: stop.id,
    name: stop.name,
    desc: stop.desc,
    lat: stop.lat,
    lon: stop.lon,
    distance: Math.round(distance),
    routes
  };
}

function publicPlace(data, place) {
  return {
    id: place.id,
    name: place.name,
    shortName: place.shortName || place.name,
    type: place.type,
    lat: place.lat,
    lon: place.lon,
    stopIds: place.stopIds || []
  };
}

function searchPlaces(data, query, lat, lon) {
  const normalized = normalizeText(query);
  const results = [];
  const seen = new Set();

  for (const landmark of data.landmarks) {
    if (!normalized || normalizeText(landmark.name).includes(normalized)) {
      results.push(publicPlace(data, landmark));
      seen.add(landmark.id);
    }
  }

  const rankedStops = data.stopList
    .map((stop) => {
      const name = normalizeText(stop.name);
      const desc = normalizeText(stop.desc);
      let score = 0;
      if (name === normalized) score += 100;
      if (name.includes(normalized)) score += 50;
      if (desc.includes(normalized)) score += 20;
      if (normalized && name.startsWith(normalized)) score += 10;
      if (lat != null && lon != null) {
        const distance = haversineMeters(Number(lat), Number(lon), stop.lat, stop.lon);
        if (distance <= 5000) score += Math.max(0, 20 - distance / 300);
      }
      return { stop, score, distance: lat != null && lon != null ? haversineMeters(Number(lat), Number(lon), stop.lat, stop.lon) : null };
    })
    .filter((item) => normalized ? item.score > 0 : (item.distance != null && item.distance < 1800))
    .sort((a, b) => b.score - a.score || (a.distance ?? Infinity) - (b.distance ?? Infinity))
    .slice(0, 30);

  for (const item of rankedStops) {
    const id = `stop:${item.stop.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    results.push(publicStop(data, item.stop, item.distance ?? 0));
    if (results.length >= 40) break;
  }
  return results.slice(0, 40);
}

function longToNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value.toNumber === 'function') return value.toNumber();
  if (value.low != null) return Number(value.low) + Number(value.high || 0) * 2 ** 32;
  return Number(value);
}

function decodeFeed(buffer) {
  return transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
}

function updateDelayFromStop(event, trip) {
  if (!event || !trip) return null;
  if (event.delay != null) return longToNumber(event.delay);
  if (event.time == null) return null;
  const actual = longToNumber(event.time);
  if (actual == null) return null;
  const staticStop = trip.stopTimes.find((item) => item.sequence === event.stopSequence || item.stopId === event.stopId);
  if (!staticStop) return null;
  const scheduled = staticStop.arrival ?? staticStop.departure;
  const actualLocal = epochToLocalSeconds(actual);
  if (scheduled == null || actualLocal == null) return null;
  let difference = actualLocal - scheduled;
  if (difference > 12 * 3600) difference -= 86400;
  if (difference < -12 * 3600) difference += 86400;
  return difference;
}

async function fetchLive(force = false) {
  if (!force && liveCache.at && Date.now() - liveCache.at < LIVE_CACHE_MS) return liveCache;
  if (livePromise) return livePromise;
  livePromise = (async () => {
    const [positionResult, updateResult] = await Promise.allSettled([
      fetchBuffer(FEED_URLS.positions, 15_000),
      fetchBuffer(FEED_URLS.updates, 15_000)
    ]);
    const vehicles = [];
    const updates = new Map();
    const transit = transitData;
    const errors = {
      positions: positionResult.status === 'rejected' ? positionResult.reason.message : null,
      updates: updateResult.status === 'rejected' ? updateResult.reason.message : null
    };

    if (positionResult.status === 'fulfilled') {
      try {
        const feed = decodeFeed(positionResult.value);
        for (const entity of feed.entity || []) {
          const position = entity.vehicle?.position;
          const tripId = entity.vehicle?.trip?.tripId;
          const routeId = entity.vehicle?.trip?.routeId;
          if (!position || !tripId || !Number.isFinite(Number(position.latitude)) || !Number.isFinite(Number(position.longitude))) continue;
          const route = transit?.routes.get(routeId);
          const trip = transit?.trips.get(tripId);
          const timestamp = longToNumber(entity.vehicle?.timestamp);
          vehicles.push({
            id: String(entity.id || entity.vehicle?.vehicle?.id || tripId),
            tripId,
            routeId: routeId || null,
            route: route?.shortName || routeId || '—',
            headsign: trip?.headsign || route?.longName || '',
            lat: Number(position.latitude),
            lon: Number(position.longitude),
            bearing: Number(position.bearing || 0),
            speed: Number(position.speed || 0) * 3.6,
            vehicleId: entity.vehicle?.vehicle?.id || '',
            updatedAt: timestamp ? new Date(timestamp * 1000).toISOString() : null,
            timestamp
          });
        }
      } catch (error) {
        errors.positions = `Не вдалося розшифрувати позиції: ${error.message}`;
      }
    }

    if (updateResult.status === 'fulfilled') {
      try {
        const feed = decodeFeed(updateResult.value);
        for (const entity of feed.entity || []) {
          const tripUpdate = entity.tripUpdate;
          const tripId = tripUpdate?.trip?.tripId || entity.id;
          if (!tripId) continue;
          const trip = transit?.trips.get(tripId);
          const delays = [];
          let nextStop = null;
          for (const stopUpdate of tripUpdate.stopTimeUpdate || []) {
            const event = stopUpdate.arrival || stopUpdate.departure;
            const delay = updateDelayFromStop({ ...stopUpdate, ...(event || {}) }, trip);
            if (delay != null) delays.push(delay);
            if (!nextStop && stopUpdate.stopId) nextStop = stopUpdate.stopId;
          }
          updates.set(tripId, {
            tripId,
            serviceDate: tripUpdate.trip?.startDate || null,
            delaySeconds: delays.length ? Math.round(delays.reduce((sum, value) => sum + value, 0) / delays.length) : null,
            maxDelaySeconds: delays.length ? Math.max(...delays) : null,
            nextStopId: nextStop,
            updatedAt: tripUpdate.timestamp ? new Date(longToNumber(tripUpdate.timestamp) * 1000).toISOString() : null
          });
        }
      } catch (error) {
        errors.updates = `Не вдалося розшифрувати оновлення: ${error.message}`;
      }
    }

    const now = Date.now();
    liveCache = {
      at: now,
      vehicles: vehicles.filter((vehicle) => !vehicle.timestamp || now - vehicle.timestamp * 1000 < 5 * 60_000),
      updates,
      alerts: [],
      errors
    };
    return liveCache;
  })().finally(() => {
    livePromise = undefined;
  });
  return livePromise;
}

function getLiveVehicles(query) {
  const lat = Number(query.get('lat'));
  const lon = Number(query.get('lon'));
  const radius = clamp(numberValue(query.get('radius'), 3500), 100, 30_000);
  const routeFilter = String(query.get('route') || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  const routeIds = new Set(routeFilter);
  return liveCache.vehicles
    .filter((vehicle) => {
      if (routeIds.size && !routeIds.has(String(vehicle.route).toLowerCase()) && !routeIds.has(String(vehicle.routeId).toLowerCase())) return false;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return true;
      return haversineMeters(lat, lon, vehicle.lat, vehicle.lon) <= radius;
    })
    .map((vehicle) => {
      const update = liveCache.updates.get(vehicle.tripId);
      return {
        ...vehicle,
        distance: Number.isFinite(lat) && Number.isFinite(lon) ? Math.round(haversineMeters(lat, lon, vehicle.lat, vehicle.lon)) : null,
        ageSeconds: vehicle.timestamp ? Math.max(0, Math.round((Date.now() - vehicle.timestamp * 1000) / 1000)) : null,
        delaySeconds: update?.delaySeconds ?? null
      };
    })
    .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
    .slice(0, 300);
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, transitLoaded: Boolean(transitData), liveAt: liveCache.at || null });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/reverse') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      sendError(res, 400, 'Невірні координати.');
      return true;
    }
    sendJson(res, 200, await reverseGeocode(lat, lon));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/places') {
    const data = await getTransit();
    const query = url.searchParams.get('q') || '';
    const lat = url.searchParams.get('lat');
    const lon = url.searchParams.get('lon');
    sendJson(res, 200, { places: searchPlaces(data, query, lat, lon), source: data.source });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/plan') {
    const data = await getTransit();
    // A short best-effort live refresh makes the recommendation useful immediately,
    // but a slow or unavailable realtime feed never blocks scheduled planning.
    await Promise.race([
      fetchLive().catch(() => null),
      new Promise((resolve) => setTimeout(resolve, 1800))
    ]);
    const fromRaw = url.searchParams.get('from') || '';
    const toRaw = url.searchParams.get('to') || '';
    const from = resolvePlace(data, fromRaw, numberValue(url.searchParams.get('fromLat'), NaN), numberValue(url.searchParams.get('fromLon'), NaN));
    const to = resolvePlace(data, toRaw, numberValue(url.searchParams.get('toLat'), NaN), numberValue(url.searchParams.get('toLon'), NaN));
    if (!from || !to) {
      sendError(res, 400, 'Не вдалося знайти початок або пункт призначення.', {
        fromFound: Boolean(from),
        toFound: Boolean(to)
      });
      return true;
    }
    const departure = localDateTimeFromInput(url.searchParams.get('at'));
    const preference = url.searchParams.get('preference') === 'simple' ? 'simple' : 'fastest';
    const result = planJourney(data, from, to, departure, preference);
    sendJson(res, 200, {
      ...result,
      from: publicPlace(data, from),
      to: publicPlace(data, to),
      departure: {
        date: departure.dateKey,
        time: departure.epochMs,
        localTime: departure.seconds
      },
      preference,
      source: data.source,
      generatedAt: new Date().toISOString()
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/live') {
    await fetchLive();
    sendJson(res, 200, {
      updatedAt: liveCache.at ? new Date(liveCache.at).toISOString() : null,
      vehicles: getLiveVehicles(url.searchParams),
      errors: liveCache.errors || {},
      source: TRANSIT_SOURCE
    });
    return true;
  }

  return false;
}

async function serveStatic(req, res, url) {
  let requested = decodeURIComponent(url.pathname);
  if (requested === '/') requested = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, 'Forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not file');
    const extension = path.extname(filePath).toLowerCase();
    const cache = ['.html', '.webmanifest', '.js', '.css'].includes(extension) || filePath.endsWith('sw.js')
      ? 'no-cache, no-store, must-revalidate'
      : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cache
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    if (url.pathname.startsWith('/api/')) sendError(res, 404, 'Not found');
    else sendText(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }
  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendError(res, 404, 'Unknown API endpoint');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'Method not allowed');
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendError(res, 503, 'Сервер тимчасово не може обробити запит.', error.message);
    else res.end();
  }
});

getTransit().catch((error) => console.error('Initial GTFS load failed:', error.message));

server.listen(PORT, HOST, () => {
  console.log(`Lviv Transit PWA listening on http://${HOST}:${PORT}`);
});
