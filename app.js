'use strict';

// ===================== Speicher =====================
const S_ORTE = 'wetter-orte';
const S_GPS = 'wetter-gps';
const S_GPS_ORT = 'wetter-gps-ort';
const S_AKTIV = 'wetter-aktiv';
const S_DATEN = 'wetter-daten-';
const S_RADAR_WARN = 'wetter-radar-warnungen';
// Nach 10 Minuten gelten Wetterdaten als veraltet und werden neu geholt.
const MAX_ALTER = 10 * 60 * 1000;

function lies(schluessel, ersatz) {
  try {
    const wert = localStorage.getItem(schluessel);
    return wert === null ? ersatz : JSON.parse(wert);
  } catch {
    return ersatz;
  }
}
function schreibe(schluessel, wert) {
  try { localStorage.setItem(schluessel, JSON.stringify(wert)); } catch { /* Speicher voll oder gesperrt */ }
}
function entferne(schluessel) {
  try { localStorage.removeItem(schluessel); } catch { /* egal */ }
}

let orte = lies(S_ORTE, []);          // selbst angelegte Orte
let gpsAn = lies(S_GPS, true);
let gpsOrt = lies(S_GPS_ORT, null);   // { lat, lon, name } des zuletzt ermittelten Standorts
let aktiveId = lies(S_AKTIV, null);

const daten = new Map();        // Ort-ID → { zeit, wetter, pollen, warnungen }
const laedt = new Map();        // Ort-ID → laufendes Laden
const fehlerTexte = new Map();  // Ort-ID → letzte Fehlermeldung
const seiten = new Map();       // Ort-ID → Seiten-Element
const offeneTage = new Set();   // "ortId:datum" der aufgeklappten Tage

const $ = (sel, el = document) => el.querySelector(sel);

function alleOrte() {
  const liste = [];
  if (gpsAn) {
    liste.push({
      id: 'gps',
      gps: true,
      name: (gpsOrt && gpsOrt.name) || 'Mein Standort',
      region: 'Aktueller Standort',
      lat: gpsOrt ? gpsOrt.lat : undefined,
      lon: gpsOrt ? gpsOrt.lon : undefined,
    });
  }
  return liste.concat(orte);
}
function ortMitId(id) { return alleOrte().find((o) => o.id === id) || null; }
function aktiverOrt() {
  const liste = alleOrte();
  return liste.find((o) => o.id === aktiveId) || liste[0] || null;
}

// ===================== Hilfsfunktionen =====================
function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (z) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[z]));
}
function rund(x) { return x === null || x === undefined || Number.isNaN(x) ? '–' : String(Math.round(x)); }
function zahl(x, stellen = 1) { return x === null || x === undefined ? '–' : x.toLocaleString('de-DE', { maximumFractionDigits: stellen }); }

let statusTimer;
function zeigeStatus(text) {
  const el = $('#status');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

async function holeJson(url, ms = 15000) {
  const steuerung = new AbortController();
  const uhr = setTimeout(() => steuerung.abort(), ms);
  try {
    const antwort = await fetch(url, { signal: steuerung.signal });
    if (!antwort.ok) throw new Error('Server antwortet mit Fehler ' + antwort.status);
    return await antwort.json();
  } finally {
    clearTimeout(uhr);
  }
}

function entfernungKm(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// Grobe Umrandung, in der DWD-Radar und -Warnungen vorliegen.
function inDeutschland(lat, lon) {
  return lat >= 47.2 && lat <= 55.1 && lon >= 5.8 && lon <= 15.1;
}

// Open-Meteo liefert Ortszeit als Text ("2026-11-15T14:30"). Gerechnet wird mit diesen Texten,
// damit Uhrzeiten immer in der Zeitzone des Ortes stimmen.
function lokalJetzt(wetter) {
  return new Date(Date.now() + wetter.utc_offset_seconds * 1000).toISOString().slice(0, 16);
}
function verschiebe(zeit, minuten) {
  return new Date(Date.parse(zeit + 'Z') + minuten * 60000).toISOString().slice(0, 16);
}
const uhr = (zeit) => zeit.slice(11, 16);
const WOCHENTAGE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
function wochentag(datum) { return WOCHENTAGE[new Date(datum.slice(0, 10) + 'T12:00Z').getUTCDay()]; }

function formatUtc(iso, zeitzone) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('de-DE', {
    weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: zeitzone || 'Europe/Berlin',
  }).format(new Date(iso));
}
function uhrzeitVon(ms) {
  return new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

// ===================== Wettercodes (WMO) =====================
const CODES = {
  0: ['Klar', '☀️', '🌙', 'klar'],
  1: ['Überwiegend klar', '🌤️', '🌙', 'klar'],
  2: ['Teilweise bewölkt', '⛅', '☁️', 'wolkig'],
  3: ['Bedeckt', '☁️', '☁️', 'wolkig'],
  45: ['Nebel', '🌫️', '🌫️', 'nebel'],
  48: ['Nebel mit Reif', '🌫️', '🌫️', 'nebel'],
  51: ['Leichter Nieselregen', '🌦️', '🌧️', 'regen'],
  53: ['Nieselregen', '🌧️', '🌧️', 'regen'],
  55: ['Starker Nieselregen', '🌧️', '🌧️', 'regen'],
  56: ['Gefrierender Nieselregen', '🌧️', '🌧️', 'regen'],
  57: ['Gefrierender Nieselregen', '🌧️', '🌧️', 'regen'],
  61: ['Leichter Regen', '🌦️', '🌧️', 'regen'],
  63: ['Regen', '🌧️', '🌧️', 'regen'],
  65: ['Starker Regen', '🌧️', '🌧️', 'regen'],
  66: ['Gefrierender Regen', '🌧️', '🌧️', 'regen'],
  67: ['Starker gefrierender Regen', '🌧️', '🌧️', 'regen'],
  71: ['Leichter Schneefall', '🌨️', '🌨️', 'schnee'],
  73: ['Schneefall', '🌨️', '🌨️', 'schnee'],
  75: ['Starker Schneefall', '❄️', '❄️', 'schnee'],
  77: ['Schneegriesel', '🌨️', '🌨️', 'schnee'],
  80: ['Leichte Regenschauer', '🌦️', '🌧️', 'regen'],
  81: ['Regenschauer', '🌦️', '🌧️', 'regen'],
  82: ['Heftige Regenschauer', '🌧️', '🌧️', 'regen'],
  85: ['Leichte Schneeschauer', '🌨️', '🌨️', 'schnee'],
  86: ['Schneeschauer', '🌨️', '🌨️', 'schnee'],
  95: ['Gewitter', '⛈️', '⛈️', 'gewitter'],
  96: ['Gewitter mit Hagel', '⛈️', '⛈️', 'gewitter'],
  99: ['Schweres Gewitter mit Hagel', '⛈️', '⛈️', 'gewitter'],
};
function wetterCode(code, tag = true) {
  const e = CODES[code] || ['Unbekannt', '❔', '❔', 'wolkig'];
  return { text: e[0], symbol: tag ? e[1] : e[2], art: e[3] };
}
const RICHTUNGEN = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
const himmelsrichtung = (grad) => RICHTUNGEN[Math.round(grad / 45) % 8];

// ===================== Laden =====================
function holePosition() {
  return new Promise((ok, fehler) => {
    if (!navigator.geolocation) { fehler(new Error('kein GPS')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude }),
      fehler,
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 }
    );
  });
}

async function ortsnameZu(lat, lon) {
  // Auf ca. 100 m gerundet: genauer braucht der Ortsname nicht zu sein.
  const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=de'
    + `&lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`;
  const d = await holeJson(url, 10000);
  const a = d.address || {};
  return a.village || a.town || a.city || a.municipality || a.suburb || a.county || d.name || null;
}

async function aktualisiereGps() {
  try {
    const pos = await holePosition();
    const alt = gpsOrt;
    let name = alt && alt.name;
    if (!alt || !name || entfernungKm(alt, pos) > 1.5) {
      name = await ortsnameZu(pos.lat, pos.lon).catch(() => (alt && entfernungKm(alt, pos) < 10 ? alt.name : null));
    }
    gpsOrt = { lat: pos.lat, lon: pos.lon, name: name || 'Mein Standort' };
    schreibe(S_GPS_ORT, gpsOrt);
  } catch (e) {
    const grund = e && e.code === 1 ? 'Der Standortzugriff ist nicht erlaubt.' : 'Der Standort konnte nicht ermittelt werden.';
    if (!gpsOrt) throw new Error(grund + ' Erlaube den Standort für diese Seite in Chrome oder füge unter „Orte“ einen Ort hinzu.');
    zeigeStatus(grund + ' Es wird der zuletzt bekannte Standort verwendet.');
  }
  return ortMitId('gps');
}

async function ladeWarnungen(ort) {
  const felder = 'IDENTIFIER,EVENT,HEADLINE,DESCRIPTION,INSTRUCTION,SEVERITY,EC_AREA_COLOR,ONSET,EXPIRES';
  const filter = encodeURIComponent(`INTERSECTS(THE_GEOM,POINT(${ort.lat.toFixed(4)} ${ort.lon.toFixed(4)}))`);
  const url = 'https://maps.dwd.de/geoserver/dwd/ows?service=WFS&version=2.0.0&request=GetFeature'
    + `&typeName=dwd:Warnungen_Gemeinden&outputFormat=application/json&propertyName=${felder}&CQL_FILTER=${filter}`;
  const d = await holeJson(url);
  const gesehen = new Set();
  return (d.features || []).map((f) => f.properties).filter((p) => {
    if (!p || gesehen.has(p.IDENTIFIER)) return false;
    gesehen.add(p.IDENTIFIER);
    return true;
  });
}

async function ladeWetter(ort) {
  const lage = `latitude=${ort.lat.toFixed(4)}&longitude=${ort.lon.toFixed(4)}`;
  const urlWetter = `https://api.open-meteo.com/v1/forecast?${lage}&timezone=auto&forecast_days=8`
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,cloud_cover'
    + '&hourly=temperature_2m,weather_code,precipitation_probability,precipitation,is_day,uv_index'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset,uv_index_max,wind_gusts_10m_max'
    + '&minutely_15=precipitation&past_minutely_15=1&forecast_minutely_15=10';
  const urlPollen = `https://air-quality-api.open-meteo.com/v1/air-quality?${lage}&timezone=auto&forecast_days=2`
    + '&hourly=alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,ragweed_pollen';
  const [wetter, pollen, warnungen] = await Promise.all([
    holeJson(urlWetter),
    holeJson(urlPollen).catch(() => null),
    inDeutschland(ort.lat, ort.lon) ? ladeWarnungen(ort).catch(() => null) : Promise.resolve([]),
  ]);
  return { zeit: Date.now(), lat: ort.lat, lon: ort.lon, wetter, pollen, warnungen };
}

function holeGespeichert(id) {
  if (!daten.has(id)) {
    const gespeichert = lies(S_DATEN + id, null);
    if (gespeichert && gespeichert.wetter) daten.set(id, gespeichert);
  }
  return daten.get(id) || null;
}

async function aktualisiere(ort, erzwingen = false) {
  if (!ort) return;
  const vorhanden = holeGespeichert(ort.id);
  const frisch = vorhanden && Date.now() - vorhanden.zeit < MAX_ALTER;
  if (!erzwingen && frisch) return;
  if (laedt.has(ort.id)) return laedt.get(ort.id);

  const arbeit = (async () => {
    const ziel = ort.gps ? await aktualisiereGps() : ort;
    const neu = await ladeWetter(ziel);
    daten.set(ort.id, neu);
    schreibe(S_DATEN + ort.id, neu);
    fehlerTexte.delete(ort.id);
  })();
  // Wer parallel nachfragt, wartet nur mit; Fehler meldet allein dieser Aufruf.
  laedt.set(ort.id, arbeit.catch(() => {}));
  zeichneSeite(ort.id);
  try {
    await arbeit;
  } catch (e) {
    const offline = !navigator.onLine || (e && (e.name === 'AbortError' || e.name === 'TypeError'));
    fehlerTexte.set(ort.id, offline ? 'Keine Verbindung zum Wetterdienst.' : (e && e.message) || 'Laden fehlgeschlagen.');
  } finally {
    laedt.delete(ort.id);
    zeichneSeite(ort.id);
    zeichneOrteListe();
    if (karte) zeichneMarker();
  }
}

// ===================== Wetter-Seiten =====================
function baueBand() {
  const band = $('#band');
  band.innerHTML = '';
  seiten.clear();
  const liste = alleOrte();
  if (!liste.length) {
    band.innerHTML = `<div class="seite"><div class="leer">
      <div class="gross">🌍</div>
      <p>Noch kein Ort angelegt.</p>
      <button class="knopf" type="button" data-aktion="zu-orte">Ort hinzufügen</button>
    </div></div>`;
    $('#punkte').innerHTML = '';
    return;
  }
  for (const ort of liste) {
    const el = document.createElement('div');
    el.className = 'seite';
    el.dataset.id = ort.id;
    band.append(el);
    seiten.set(ort.id, el);
    holeGespeichert(ort.id);
    zeichneSeite(ort.id);
  }
  aktiveId = aktiverOrt().id;
  springeZuAktiv();
  zeichnePunkte();
}

function springeZuAktiv() {
  const band = $('#band');
  const idx = alleOrte().findIndex((o) => o.id === aktiveId);
  if (idx >= 0 && band.clientWidth) band.scrollLeft = idx * band.clientWidth;
}

function zeichnePunkte() {
  const liste = alleOrte();
  $('#punkte').innerHTML = liste.length < 2 ? '' : liste
    .map((o) => `<i class="${o.id === aktiveId ? 'aktiv' : ''} ${o.gps ? 'gps' : ''}"></i>`).join('');
}

function setzeAktiv(id) {
  if (aktiveId === id) return;
  aktiveId = id;
  schreibe(S_AKTIV, id);
  zeichnePunkte();
  aktualisiere(ortMitId(id));
  if (karte) { zeichneMarker(); radarZielGeaendert = true; }
}

function zeichneSeite(id) {
  const el = seiten.get(id);
  const ort = ortMitId(id);
  if (!el || !ort) return;
  const d = daten.get(id);
  const ladend = laedt.has(id);
  const fehler = fehlerTexte.get(id);
  if (!d) {
    el.innerHTML = `
      <header class="kopf">
        <div class="kopf-zeile"><h2>${esc(ort.name)}${ort.gps ? '<span class="gps-zeichen">📍</span>' : ''}</h2>
          <button class="neu ${ladend ? 'dreht' : ''}" type="button" data-aktion="neu" aria-label="Aktualisieren">⟳</button></div>
        <div class="stand">${ladend ? (ort.gps && !ort.lat ? 'Standort wird ermittelt …' : 'Wetter wird geladen …') : ''}</div>
      </header>
      ${fehler ? `<div class="block"><p class="hinweis fehler">${esc(fehler)}</p>
        <p style="margin-top:12px"><button class="knopf" type="button" data-aktion="neu">Erneut versuchen</button>
        ${ort.gps ? ' <button class="knopf-klein" type="button" data-aktion="zu-orte">Ort suchen</button>' : ''}</p></div>` : ''}`;
    return;
  }
  el.innerHTML = kopfHtml(ort, d, ladend)
    + (fehler ? `<div class="block"><p class="hinweis fehler">${esc(fehler)} Angezeigt wird der letzte Stand.</p></div>` : '')
    + warnungenHtml(d)
    + kurzfristHtml(d)
    + stundenHtml(d)
    + tageHtml(ort, d)
    + extrasHtml(d);
}

function standText(zeit) {
  const alter = Date.now() - zeit;
  const tag = new Date(zeit).toDateString() === new Date().toDateString()
    ? '' : WOCHENTAGE[new Date(zeit).getDay()] + ' ';
  return `Stand ${tag}${uhrzeitVon(zeit)}${alter > 3 * MAX_ALTER ? ' (veraltet)' : ''}`;
}

function kopfHtml(ort, d, ladend) {
  const w = d.wetter;
  const c = w.current;
  const tag = c.is_day === 1;
  const info = wetterCode(c.weather_code, tag);
  const art = !tag && (info.art === 'klar' || info.art === 'wolkig') ? 'nacht' : info.art;
  const t = w.daily;
  const jetzt = lokalJetzt(w);
  let sonne = '';
  if (t.sunrise && t.sunrise[0]) {
    if (jetzt < t.sunrise[0]) sonne = `Aufgang<b>${uhr(t.sunrise[0])}</b>`;
    else if (jetzt < t.sunset[0]) sonne = `Untergang<b>${uhr(t.sunset[0])}</b>`;
    else sonne = `Aufgang<b>${t.sunrise[1] ? uhr(t.sunrise[1]) : '–'}</b>`;
  }
  return `
    <header class="kopf ${art}">
      <div class="kopf-zeile">
        <h2>${esc(ort.name)}${ort.gps ? '<span class="gps-zeichen">📍</span>' : ''}</h2>
        <button class="neu ${ladend ? 'dreht' : ''}" type="button" data-aktion="neu" aria-label="Aktualisieren">⟳</button>
      </div>
      <div class="stand">${standText(d.zeit)}${ladend ? ' · wird aktualisiert …' : ''}</div>
      <div class="jetzt">
        <div class="symbol" aria-hidden="true">${info.symbol}</div>
        <div class="temp">${rund(c.temperature_2m)}°</div>
      </div>
      <div class="beschreibung">${esc(info.text)}</div>
      <div class="gefuehlt">Gefühlt ${rund(c.apparent_temperature)}° · Heute ${rund(t.temperature_2m_max[0])}° / ${rund(t.temperature_2m_min[0])}°</div>
      <div class="werte">
        <div>Wind ${himmelsrichtung(c.wind_direction_10m)}<b><span class="pfeil" style="transform:rotate(${c.wind_direction_10m}deg)">↓</span> ${rund(c.wind_speed_10m)} km/h</b></div>
        <div>Böen<b>${rund(c.wind_gusts_10m)} km/h</b></div>
        <div>Luftfeuchte<b>${rund(c.relative_humidity_2m)} %</b></div>
        <div>Luftdruck<b>${rund(c.pressure_msl)} hPa</b></div>
        <div>Bewölkung<b>${rund(c.cloud_cover)} %</b></div>
        <div>${sonne || 'Sonne<b>–</b>'}</div>
      </div>
    </header>`;
}

// ---------- Unwetterwarnungen ----------
const SCHWERE = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };
const SCHWERE_TEXT = { Extreme: 'Extremes Unwetter', Severe: 'Unwetter', Moderate: 'Markantes Wetter', Minor: 'Wetterwarnung' };

function gueltigeWarnungen(d) {
  if (!Array.isArray(d.warnungen)) return [];
  const jetzt = Date.now();
  return d.warnungen
    .filter((w) => !w.EXPIRES || Date.parse(w.EXPIRES) > jetzt)
    .sort((a, b) => (SCHWERE[b.SEVERITY] || 0) - (SCHWERE[a.SEVERITY] || 0) || Date.parse(a.ONSET) - Date.parse(b.ONSET));
}

function warnFarbe(w) {
  const teile = String(w.EC_AREA_COLOR || '255 235 59').split(/\s+/).map(Number);
  const [r, g, b] = teile.length === 3 && teile.every((x) => x >= 0) ? teile : [255, 235, 59];
  const hell = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return { farbe: `rgb(${r}, ${g}, ${b})`, dunkel: hell < 0.55 };
}

function warnZeitraum(w, zeitzone) {
  const beginnt = w.ONSET && Date.parse(w.ONSET) > Date.now();
  const bis = w.EXPIRES ? `bis ${formatUtc(w.EXPIRES, zeitzone)}` : 'bis auf Weiteres';
  return beginnt ? `ab ${formatUtc(w.ONSET, zeitzone)} ${bis}` : bis;
}

function warnungenHtml(d) {
  if (d.warnungen === null && inDeutschland(d.lat, d.lon)) {
    return '<div class="block"><p class="hinweis">Unwetterwarnungen konnten gerade nicht geladen werden.</p></div>';
  }
  const liste = gueltigeWarnungen(d);
  if (!liste.length) return '';
  const zz = d.wetter.timezone;
  const zeige = liste.slice(0, 2).map((w) => {
    const f = warnFarbe(w);
    return `<button class="warnung ${f.dunkel ? 'hell' : ''}" style="background:${f.farbe}" type="button" data-aktion="warnung">
      <span class="w-symbol" aria-hidden="true">⚠️</span>
      <span class="w-text"><strong>${esc(w.HEADLINE || w.EVENT)}</strong><small>${esc(warnZeitraum(w, zz))}</small></span>
      <span aria-hidden="true">›</span>
    </button>`;
  }).join('');
  const mehr = liste.length > 2 ? `<p class="warnungen-mehr">+ ${liste.length - 2} weitere Warnung${liste.length - 2 > 1 ? 'en' : ''}</p>` : '';
  return zeige + mehr;
}

function oeffneWarnungen(d) {
  const zz = d.wetter.timezone;
  $('#warn-inhalt').innerHTML = gueltigeWarnungen(d).map((w) => {
    const f = warnFarbe(w);
    return `<div class="warn-eintrag" style="border-color:${f.farbe}">
      <h4>${esc(w.HEADLINE || w.EVENT)}</h4>
      <p class="zeitraum">${esc(SCHWERE_TEXT[w.SEVERITY] || '')} · ${esc(warnZeitraum(w, zz))}</p>
      ${w.DESCRIPTION ? `<p>${esc(w.DESCRIPTION)}</p>` : ''}
      ${w.INSTRUCTION ? `<p class="anweisung">${esc(w.INSTRUCTION)}</p>` : ''}
    </div>`;
  }).join('') + '<p class="warn-quelle">Quelle: Deutscher Wetterdienst</p>';
  $('#warn-dialog').showModal();
}

// ---------- Regen in den nächsten 2 Stunden ----------
function kurzfristHtml(d) {
  const w = d.wetter;
  const m = w.minutely_15;
  if (!m || !m.time) return '';
  const jetzt = lokalJetzt(w);
  // Jeder Wert ist die Menge der vorangegangenen 15 Minuten; gesucht sind die Abschnitte, die noch nicht vorbei sind.
  const start = m.time.findIndex((t) => t > jetzt);
  if (start < 0) return '';
  const abschnitte = m.time.slice(start, start + 8).map((ende, i) => ({
    beginn: verschiebe(ende, -15), ende, mmh: (m.precipitation[start + i] || 0) * 4,
  }));
  if (abschnitte.length < 4) return '';
  const schnee = w.current.temperature_2m <= 0.5;
  const nass = (a) => a.mmh >= 0.2;
  const staerke = (mmh) => (mmh < 2.5 ? 'Leichter' : mmh < 10 ? 'Mäßiger' : 'Starker');
  const wort = schnee ? 'Schneefall' : 'Regen';
  const letztes = abschnitte[abschnitte.length - 1];
  const maxMmh = Math.max(...abschnitte.map((a) => a.mmh));
  let satz;
  if (nass(abschnitte[0])) {
    const trocken = abschnitte.findIndex((a) => !nass(a));
    satz = trocken < 0
      ? `${staerke(maxMmh)} ${wort} bis mindestens ${uhr(letztes.ende)}`
      : `${wort} lässt gegen ${uhr(abschnitte[trocken].beginn)} nach`;
  } else {
    const nassAb = abschnitte.findIndex(nass);
    satz = nassAb < 0
      ? `Trocken bis mindestens ${uhr(letztes.ende)}`
      : `${staerke(maxMmh)} ${wort} ab etwa ${uhr(abschnitte[nassAb].beginn)}`;
  }
  const balken = abschnitte.map((a) => {
    const hoehe = nass(a) ? Math.round(10 + 90 * Math.min(1, Math.sqrt(a.mmh / 8))) : 0;
    return `<div class="${nass(a) ? '' : 'trocken'}" style="height:${hoehe ? hoehe + '%' : '3px'}" title="${uhr(a.beginn)}: ${zahl(a.mmh)} mm/h"></div>`;
  }).join('');
  return `<section class="block">
    <h3>Die nächsten 2 Stunden</h3>
    <p class="kurzfrist-satz">${abschnitte.some(nass) ? (schnee ? '🌨️' : '☔') : '🌂'} ${esc(satz)}</p>
    <div class="balken ${abschnitte.some(nass) ? '' : 'flach'}">${balken}</div>
    <div class="balken-achse"><span>${uhr(abschnitte[0].beginn)}</span><span>${uhr(abschnitte[Math.floor(abschnitte.length / 2)].beginn)}</span><span>${uhr(letztes.ende)}</span></div>
  </section>`;
}

// ---------- 24 Stunden ----------
function stundenHtml(d) {
  const w = d.wetter;
  const h = w.hourly;
  const stundeJetzt = lokalJetzt(w).slice(0, 13) + ':00';
  const start = h.time.findIndex((t) => t >= stundeJetzt);
  if (start < 0) return '';
  let html = '';
  for (let i = start; i < Math.min(start + 25, h.time.length); i++) {
    const info = wetterCode(h.weather_code[i], h.is_day[i] === 1);
    const p = h.precipitation_probability[i];
    html += `<div class="stunde ${i === start ? 'jetzt-h' : ''}">
      <div class="s-zeit">${i === start ? 'Jetzt' : uhr(h.time[i]).slice(0, 2) + ' Uhr'}</div>
      <div class="s-symbol" title="${esc(info.text)}">${info.symbol}</div>
      <div class="s-temp">${rund(h.temperature_2m[i])}°</div>
      <div class="s-regen">${p >= 10 ? p + ' %' : ''}</div>
    </div>`;
  }
  return `<section class="block"><h3>24 Stunden</h3><div class="stunden">${html}</div></section>`;
}

// ---------- 7 Tage ----------
function tageHtml(ort, d) {
  const t = d.wetter.daily;
  const anzahl = Math.min(7, t.time.length);
  const tief = Math.min(...t.temperature_2m_min.slice(0, anzahl));
  const hoch = Math.max(...t.temperature_2m_max.slice(0, anzahl));
  const spanne = Math.max(1, hoch - tief);
  let html = '';
  for (let i = 0; i < anzahl; i++) {
    const datum = t.time[i];
    const name = i === 0 ? 'Heute' : i === 1 ? 'Morgen' : `${wochentag(datum)} ${Number(datum.slice(8, 10))}.`;
    const info = wetterCode(t.weather_code[i]);
    const p = t.precipitation_probability_max[i];
    const links = ((t.temperature_2m_min[i] - tief) / spanne) * 100;
    const breite = Math.max(4, ((t.temperature_2m_max[i] - t.temperature_2m_min[i]) / spanne) * 100);
    const schluessel = `${ort.id}:${datum}`;
    const offen = offeneTage.has(schluessel);
    html += `<button class="tag" type="button" data-aktion="tag" data-tag="${esc(schluessel)}" aria-expanded="${offen}">
        <span class="t-name">${name}${p >= 10 ? `<small>💧 ${p} %</small>` : ''}</span>
        <span class="t-symbol" title="${esc(info.text)}">${info.symbol}</span>
        <span class="t-min">${rund(t.temperature_2m_min[i])}°</span>
        <span class="spanne"><span style="left:${links.toFixed(1)}%;width:${Math.min(100 - links, breite).toFixed(1)}%"></span></span>
        <span class="t-max">${rund(t.temperature_2m_max[i])}°</span>
      </button>
      <div class="tag-details" ${offen ? '' : 'hidden'}>
        <span>${esc(info.text)}</span><span></span>
        <span>Sonnenaufgang <b>${t.sunrise[i] ? uhr(t.sunrise[i]) : '–'}</b></span>
        <span>Sonnenuntergang <b>${t.sunset[i] ? uhr(t.sunset[i]) : '–'}</b></span>
        <span>Niederschlag <b>${zahl(t.precipitation_sum[i])} mm</b></span>
        <span>Wahrscheinlichkeit <b>${p ?? '–'} %</b></span>
        <span>Böen bis <b>${rund(t.wind_gusts_10m_max[i])} km/h</b></span>
        <span>UV-Index <b>${zahl(t.uv_index_max[i], 0)}</b></span>
      </div>`;
  }
  return `<section class="block"><h3>7 Tage</h3>${html}</section>`;
}

// ---------- UV & Pollen ----------
function uvStufe(uv) {
  if (uv < 3) return ['niedrig', '#7bd389'];
  if (uv < 6) return ['mäßig', '#ffe066'];
  if (uv < 8) return ['hoch', '#ffa94d'];
  if (uv < 11) return ['sehr hoch', '#ff6b6b'];
  return ['extrem', '#c084fc'];
}

// Pollen in Körnern pro m³; Schwellen grob an den Belastungsstufen des DWD orientiert.
const POLLEN = [
  ['alder_pollen', 'Erle', 10, 50],
  ['birch_pollen', 'Birke', 10, 50],
  ['grass_pollen', 'Gräser', 5, 30],
  ['mugwort_pollen', 'Beifuß', 3, 15],
  ['ragweed_pollen', 'Ambrosia', 3, 10],
];
function pollenStufe(wert, mittel, hoch) {
  if (wert < 1) return null;
  if (wert < mittel) return ['gering', '#bfe3a6'];
  if (wert < hoch) return ['mittel', '#ffd166'];
  return ['hoch', '#ff7b6b'];
}

function extrasHtml(d) {
  const w = d.wetter;
  const jetzt = lokalJetzt(w);
  const heute = jetzt.slice(0, 10);
  // UV
  const stunde = w.hourly.time.findIndex((t) => t >= jetzt.slice(0, 13) + ':00');
  const uvJetzt = stunde >= 0 ? w.hourly.uv_index[stunde] : null;
  const uvMax = w.daily.uv_index_max[0];
  let uvHtml = '<p class="hinweis">Keine UV-Daten</p>';
  if (uvMax !== null && uvMax !== undefined) {
    const [text, farbe] = uvStufe(uvMax);
    uvHtml = `<div class="uv-wert">${zahl(uvMax, 0)}</div>
      <span class="stufe" style="background:${farbe}">${text}</span>
      <p class="hinweis" style="margin-top:6px">Höchstwert heute${uvJetzt !== null && uvJetzt !== undefined ? ` · jetzt ${zahl(uvJetzt, 0)}` : ''}</p>`;
  }
  // Pollen: höchster Wert der restlichen Stunden von heute
  let pollenHtml;
  const ph = d.pollen && d.pollen.hourly;
  if (!ph || !ph.time) {
    pollenHtml = '<p class="hinweis">Keine Pollendaten für diesen Ort.</p>';
  } else {
    const idx = ph.time.map((t, i) => (t.slice(0, 10) === heute && t >= jetzt.slice(0, 13) ? i : -1)).filter((i) => i >= 0);
    const bereich = idx.length ? idx : ph.time.map((t, i) => (t.slice(0, 10) === heute ? i : -1)).filter((i) => i >= 0);
    let irgendwelche = false;
    const zeilen = POLLEN.map(([feld, name, mittel, hoch]) => {
      const werte = bereich.map((i) => (ph[feld] || [])[i]).filter((x) => x !== null && x !== undefined);
      if (werte.length) irgendwelche = true;
      const stufe = werte.length ? pollenStufe(Math.max(...werte), mittel, hoch) : null;
      return stufe ? `<li>${name}<span class="stufe" style="background:${stufe[1]}">${stufe[0]}</span></li>` : '';
    }).join('');
    pollenHtml = !irgendwelche
      ? '<p class="hinweis">Keine Pollendaten für diesen Ort.</p>'
      : zeilen ? `<ul class="pollen-liste">${zeilen}</ul>` : '<p class="hinweis">Zurzeit kein nennenswerter Pollenflug.</p>';
  }
  return `<div class="zweier">
    <section class="block"><h3>UV-Index</h3>${uvHtml}</section>
    <section class="block"><h3>Pollen heute</h3>${pollenHtml}</section>
  </div>`;
}

// ===================== Orte =====================
function speichereOrte() { schreibe(S_ORTE, orte); }

function zeichneOrteListe() {
  const liste = $('#orte-liste');
  if (!liste) return;
  const eintraege = alleOrte();
  liste.innerHTML = eintraege.map((o) => {
    const d = daten.get(o.id);
    const temp = d ? `${rund(d.wetter.current.temperature_2m)}°` : '';
    const symbol = d ? wetterCode(d.wetter.current.weather_code, d.wetter.current.is_day === 1).symbol : '';
    const posEigene = orte.findIndex((x) => x.id === o.id);
    const knoepfe = o.gps ? '' : `
      <button class="icon-knopf" type="button" data-aktion="hoch" data-id="${esc(o.id)}" aria-label="Nach oben" ${posEigene === 0 ? 'disabled' : ''}>▲</button>
      <button class="icon-knopf" type="button" data-aktion="runter" data-id="${esc(o.id)}" aria-label="Nach unten" ${posEigene === orte.length - 1 ? 'disabled' : ''}>▼</button>
      <button class="icon-knopf" type="button" data-aktion="loeschen" data-id="${esc(o.id)}" aria-label="${esc(o.name)} löschen">✕</button>`;
    return `<li>
      <button class="o-name" type="button" data-aktion="oeffnen" data-id="${esc(o.id)}">
        ${o.gps ? '📍 ' : ''}${esc(o.name)}<small>${esc(o.region || '')}</small>
      </button>
      <span class="o-temp">${symbol} ${temp}</span>
      ${knoepfe}
    </li>`;
  }).join('');
}

let suchNummer = 0;
let suchTimer;
async function suche(text) {
  const nummer = ++suchNummer;
  const vorschlaege = $('#vorschlaege');
  if (text.trim().length < 2) { vorschlaege.hidden = true; return; }
  try {
    const url = 'https://geocoding-api.open-meteo.com/v1/search?count=8&language=de&format=json&name='
      + encodeURIComponent(text.trim());
    const d = await holeJson(url, 10000);
    if (nummer !== suchNummer) return;
    const treffer = d.results || [];
    vorschlaege.innerHTML = treffer.length ? treffer.map((t, i) => {
      const region = [t.admin2 && t.admin2 !== t.name ? t.admin2 : null, t.admin1, t.country].filter(Boolean).join(', ');
      return `<li><button type="button" data-treffer="${i}">${esc(t.name)}<small>${esc(region)}</small></button></li>`;
    }).join('') : '<li><p class="hinweis" style="padding:10px 12px">Nichts gefunden.</p></li>';
    vorschlaege.hidden = false;
    vorschlaege.treffer = treffer;
  } catch {
    if (nummer !== suchNummer) return;
    vorschlaege.innerHTML = '<li><p class="hinweis fehler" style="padding:10px 12px">Suche gerade nicht möglich.</p></li>';
    vorschlaege.hidden = false;
  }
}

function fuegeOrtHinzu(t) {
  const neu = {
    id: 'o' + Date.now().toString(36),
    name: t.name,
    region: [t.admin1, t.country].filter(Boolean).join(', '),
    lat: t.latitude,
    lon: t.longitude,
  };
  const doppelt = orte.find((o) => entfernungKm(o, neu) < 1);
  $('#suche').value = '';
  $('#vorschlaege').hidden = true;
  if (doppelt) {
    zeigeStatus(`${doppelt.name} ist schon in der Liste.`);
    aktiveId = doppelt.id;
  } else {
    orte.push(neu);
    speichereOrte();
    aktiveId = neu.id;
    zeigeStatus(`${neu.name} hinzugefügt.`);
  }
  schreibe(S_AKTIV, aktiveId);
  baueBand();
  zeichneOrteListe();
  zeigeAnsicht('wetter');
  aktualisiere(aktiverOrt());
}

// ===================== Radar =====================
const WMS = 'https://maps.dwd.de/geoserver/dwd/wms';
const RADAR_EBENE = 'dwd:Niederschlagsradar';
// Eigener Dienst nur für diese Ebene: Die Zeitachse steht darin, ohne die 1 MB große Gesamtliste zu laden.
const RADAR_ZEITEN = 'https://maps.dwd.de/geoserver/dwd/Niederschlagsradar/wms?service=WMS&version=1.3.0&request=GetCapabilities';
const SCHRITT = 10;          // Minuten zwischen zwei Bildern der Animation
const VERGANGENHEIT = 120;   // Minuten Rückblick
const VORHERSAGE = 120;      // Minuten Vorhersage des DWD (RV-Produkt)
const DECKKRAFT = 0.8;

let karte = null;
let markerGruppe = null;
let warnEbene = null;
let radarBilder = [];        // { zeit, ebene, geladen }
let radarIndex = 0;
let messIndex = 0;
let radarStand = 0;
let radarSpielt = false;
let radarTimer = null;
let radarZielGeaendert = true;

function initKarte() {
  if (karte) return;
  karte = L.map('karte', { zoomControl: false, attributionControl: false, minZoom: 5, maxZoom: 12 })
    .setView([51.2, 10.4], 6);
  // TopPlusOpen (grau) des Bundesamts für Kartographie: frei nutzbar ohne Schlüssel, weltweit, in Deutschland detailliert.
  // Die OSM-Kacheln sind für Apps nicht freigegeben und wurden gesperrt.
  L.tileLayer('https://sgx.geodatenzentrum.de/wmts_topplus_open/tile/1.0.0/web_grau/default/WEBMERCATOR/{z}/{y}/{x}.png', {
    maxZoom: 18,
    className: 'basiskarte',
  }).addTo(karte);
  L.control.zoom({ position: 'topright' }).addTo(karte);
  L.control.attribution({ position: 'topleft', prefix: false })
    .addAttribution('Karte: © <a href="https://www.bkg.bund.de/">BKG</a> (<a href="https://sg.geodatenzentrum.de/web_public/Datenquellen_TopPlus_Open.pdf">Quellen</a>) · Radar: <a href="https://www.dwd.de/">DWD</a>')
    .addTo(karte);
  markerGruppe = L.layerGroup().addTo(karte);
  karte.on('moveend', pruefeAusschnitt);

  if (lies(S_RADAR_WARN, false)) {
    $('#radar-warnungen').checked = true;
    schalteWarnEbene(true);
  }
}

function zeichneMarker() {
  if (!markerGruppe) return;
  markerGruppe.clearLayers();
  for (const o of alleOrte()) {
    if (o.lat === undefined) continue;
    const aktiv = o.id === aktiveId;
    const d = daten.get(o.id);
    const marker = L.marker([o.lat, o.lon], {
      icon: L.divIcon({ className: '', html: `<div class="ort-punkt ${aktiv ? 'aktiv' : ''}"></div>`, iconSize: aktiv ? [20, 20] : [14, 14] }),
      zIndexOffset: aktiv ? 1000 : 0,
      keyboard: false,
    });
    marker.bindTooltip(`${esc(o.name)}${d ? ' · ' + rund(d.wetter.current.temperature_2m) + '°' : ''}`, { direction: 'top', offset: [0, -8] });
    marker.on('click', () => { setzeAktiv(o.id); springeZuAktiv(); zeigeRadarHinweis(); });
    marker.addTo(markerGruppe);
  }
}

function zeigeRadarHinweis() {
  const ort = aktiverOrt();
  const hinweis = $('#radar-hinweis');
  if (ort && ort.lat !== undefined && !inDeutschland(ort.lat, ort.lon)) {
    hinweis.textContent = `${ort.name} liegt außerhalb Deutschlands. Das DWD-Radar deckt nur Deutschland und die Grenzgebiete ab.`;
    hinweis.hidden = false;
  } else {
    hinweis.hidden = true;
  }
}

async function ladeRadarZeiten() {
  let ende = NaN;
  try {
    const antwort = await fetch(RADAR_ZEITEN, { cache: 'no-store' });
    const text = await antwort.text();
    const treffer = text.match(/<Dimension[^>]*name="time"[^>]*>([^<]+)</);
    if (treffer) {
      const teil = treffer[1].trim().split(',').pop().split('/');
      ende = Date.parse(teil.length >= 2 ? teil[1] : teil[0]);
    }
  } catch { /* Ersatz unten */ }
  if (!Number.isFinite(ende)) {
    // Ohne Zeitachse: Die letzte Messung liegt meist 5–10 Minuten zurück.
    ende = Math.floor(Date.now() / 300000) * 300000 - 10 * 60000 + VORHERSAGE * 60000;
  }
  const letzteMessung = ende - VORHERSAGE * 60000;
  const zeiten = [];
  for (let t = letzteMessung - VERGANGENHEIT * 60000; t <= ende; t += SCHRITT * 60000) zeiten.push(t);
  return { zeiten, messIndex: VERGANGENHEIT / SCHRITT };
}

async function bereiteRadarVor(erzwingen = false) {
  if (!erzwingen && radarBilder.length && Date.now() - radarStand < 5 * 60000) return;
  stoppeRadar();
  const { zeiten, messIndex: mi } = await ladeRadarZeiten();
  for (const b of radarBilder) if (b.ebene) karte.removeLayer(b.ebene);
  radarBilder = zeiten.map((zeit) => ({ zeit, ebene: null, geladen: false }));
  messIndex = mi;
  radarStand = Date.now();
  const regler = $('#radar-regler');
  regler.max = String(radarBilder.length - 1);
  $('#radar-skala').innerHTML = `<span>−${VERGANGENHEIT / 60} Std.</span><span>Jetzt</span><span>+${VORHERSAGE / 60} Std.</span>`;
  zeigeBild(messIndex);
}

// Pro Zeitpunkt ein einziges Bild für den sichtbaren Ausschnitt (plus Rand) statt vieler Kacheln:
// Der DWD-Server braucht pro Anfrage einige Sekunden, 25 Bilder × 6 Kacheln wären viel zu langsam.
let radarAusschnitt = null;   // { grenzen, parameter, zoom }

function berechneAusschnitt() {
  const b = karte.getBounds().pad(0.25);
  const projektion = L.CRS.EPSG3857;
  const sw = projektion.project(L.latLng(Math.max(-85, b.getSouth()), Math.max(-180, b.getWest())));
  const no = projektion.project(L.latLng(Math.min(85, b.getNorth()), Math.min(180, b.getEast())));
  const groesse = karte.getSize().multiplyBy(1.5);
  const faktor = Math.min(1, 1200 / Math.max(groesse.x, groesse.y));
  radarAusschnitt = {
    grenzen: L.latLngBounds(projektion.unproject(sw), projektion.unproject(no)),
    parameter: `&width=${Math.round(groesse.x * faktor)}&height=${Math.round(groesse.y * faktor)}`
      + `&bbox=${sw.x.toFixed(0)},${sw.y.toFixed(0)},${no.x.toFixed(0)},${no.y.toFixed(0)}`,
    zoom: karte.getZoom(),
  };
}

function radarEbene(bild) {
  if (!radarAusschnitt) berechneAusschnitt();
  if (!bild.ebene) {
    const url = `${WMS}?service=WMS&version=1.3.0&request=GetMap&layers=${RADAR_EBENE}&styles=`
      + `&format=image/png&transparent=true&crs=EPSG:3857&time=${new Date(bild.zeit).toISOString()}`
      + radarAusschnitt.parameter;
    bild.geladen = false;
    const ebene = L.imageOverlay(url, radarAusschnitt.grenzen, { opacity: 0, zIndex: 10, interactive: false });
    let versuche = 0;
    ebene.on('load', () => { bild.geladen = true; });
    // Der DWD-Server ist zeitweise überlastet; bis zu zweimal nachfordern.
    ebene.on('error', () => {
      if (versuche >= 2 || bild.ebene !== ebene) { bild.geladen = true; return; }
      versuche++;
      setTimeout(() => { if (bild.ebene === ebene) ebene.setUrl(`${url}&wdh=${versuche}`); }, 1500 * versuche);
    });
    bild.ebene = ebene;
    bild.ebene.addTo(karte);
  }
  return bild.ebene;
}

// Nach Verschieben/Zoomen nur neu laden, wenn der Ausschnitt verlassen oder deutlich hineingezoomt wurde.
function pruefeAusschnitt() {
  if (!radarBilder.length || !radarAusschnitt || $('#ansicht-radar').hidden) return;
  if (radarAusschnitt.grenzen.contains(karte.getBounds()) && karte.getZoom() - radarAusschnitt.zoom < 2) return;
  const spielte = radarSpielt;
  if (spielte) { radarSpielt = false; clearTimeout(radarTimer); }
  berechneAusschnitt();
  const aktuell = radarBilder[radarIndex];
  const altesBild = aktuell.ebene;
  radarBilder.forEach((b) => {
    if (b.ebene && b !== aktuell) karte.removeLayer(b.ebene);
    b.ebene = null;
    b.geladen = false;
  });
  // Das alte Bild bleibt stehen, bis das neue da ist – sonst blitzt die Karte leer auf.
  const neu = radarEbene(aktuell);
  neu.setOpacity(DECKKRAFT);
  if (altesBild) neu.once('load error', () => karte.removeLayer(altesBild));
  if (spielte) spieleRadar();
}

function zeigeBild(index) {
  if (!radarBilder.length) return;
  radarIndex = Math.max(0, Math.min(radarBilder.length - 1, index));
  radarBilder.forEach((b, i) => {
    if (i === radarIndex) radarEbene(b).setOpacity(DECKKRAFT);
    else if (b.ebene) b.ebene.setOpacity(0);
  });
  $('#radar-regler').value = String(radarIndex);
  const bild = radarBilder[radarIndex];
  const datum = new Date(bild.zeit);
  const heute = datum.toDateString() === new Date().toDateString();
  $('#radar-uhrzeit').textContent = (heute ? '' : WOCHENTAGE[datum.getDay()] + ' ') + uhrzeitVon(bild.zeit) + ' Uhr';
  const art = $('#radar-art');
  const diff = (radarIndex - messIndex) * SCHRITT;
  if (diff === 0) { art.textContent = 'Letzte Messung'; art.className = 'radar-art'; }
  else if (diff < 0) { art.textContent = `Messung vor ${-diff} Min.`; art.className = 'radar-art'; }
  else { art.textContent = `Vorhersage +${diff} Min.`; art.className = 'radar-art vorhersage'; }
}

function wartenAufBilder(ms) {
  return new Promise((fertig) => {
    const beginn = Date.now();
    const pruefe = () => {
      const offen = radarBilder.filter((b) => !b.geladen).length;
      if (!radarSpielt) { fertig(); return; }
      $('#radar-art').textContent = offen ? `Lade Radarbilder … ${radarBilder.length - offen}/${radarBilder.length}` : '';
      if (!offen || Date.now() - beginn > ms) fertig();
      else setTimeout(pruefe, 250);
    };
    pruefe();
  });
}

async function spieleRadar() {
  if (radarSpielt || !radarBilder.length) return;
  radarSpielt = true;
  $('#radar-abspielen').textContent = '❚❚';
  $('#radar-abspielen').setAttribute('aria-label', 'Anhalten');
  // Alle Bilder vorab laden, damit die Animation nicht flackert.
  radarBilder.forEach((b) => radarEbene(b));
  await wartenAufBilder(30000);
  if (!radarSpielt) return;
  if (radarIndex === messIndex || radarIndex >= radarBilder.length - 1) zeigeBild(0);
  const schritt = () => {
    if (!radarSpielt) return;
    const naechstes = radarIndex + 1 >= radarBilder.length ? 0 : radarIndex + 1;
    zeigeBild(naechstes);
    const pause = naechstes === radarBilder.length - 1 ? 1500 : naechstes === messIndex ? 1000 : 550;
    radarTimer = setTimeout(schritt, pause);
  };
  radarTimer = setTimeout(schritt, 400);
}

function stoppeRadar() {
  radarSpielt = false;
  clearTimeout(radarTimer);
  $('#radar-abspielen').textContent = '▶';
  $('#radar-abspielen').setAttribute('aria-label', 'Abspielen');
  // Unsichtbare Bilder abräumen, sonst lädt jedes Verschieben der Karte alle Zeitpunkte neu.
  radarBilder.forEach((b, i) => {
    if (i !== radarIndex && b.ebene) { karte.removeLayer(b.ebene); b.ebene = null; b.geladen = false; }
  });
  if (radarBilder.length) zeigeBild(radarIndex);
}

function schalteWarnEbene(an) {
  schreibe(S_RADAR_WARN, an);
  if (an && !warnEbene) {
    warnEbene = L.tileLayer.wms(WMS, {
      layers: 'dwd:Warnungen_Gemeinden_vereinigt',
      format: 'image/png',
      transparent: true,
      version: '1.3.0',
      tileSize: 512,
      opacity: 0.5,
      zIndex: 5,
    });
  }
  if (an) warnEbene.addTo(karte);
  else if (warnEbene) karte.removeLayer(warnEbene);
}

async function oeffneRadar() {
  initKarte();
  karte.invalidateSize();
  zeichneMarker();
  zeigeRadarHinweis();
  const ort = aktiverOrt();
  if (radarZielGeaendert && ort && ort.lat !== undefined) {
    karte.setView([ort.lat, ort.lon], inDeutschland(ort.lat, ort.lon) ? 8 : 6);
    radarZielGeaendert = false;
  }
  try {
    await bereiteRadarVor();
  } catch {
    zeigeStatus('Radar konnte nicht geladen werden.');
  }
}

// ===================== Ansichten =====================
let ansicht = 'wetter';
function zeigeAnsicht(name) {
  ansicht = name;
  for (const el of document.querySelectorAll('.ansicht')) el.hidden = el.id !== 'ansicht-' + name;
  for (const b of document.querySelectorAll('.leiste button')) b.classList.toggle('aktiv', b.dataset.ansicht === name);
  if (name !== 'radar' && radarSpielt) stoppeRadar();
  if (name === 'wetter') springeZuAktiv();
  if (name === 'radar') oeffneRadar();
  if (name === 'orte') zeichneOrteListe();
}

// ===================== Ereignisse =====================
document.querySelector('.leiste').addEventListener('click', (e) => {
  const knopf = e.target.closest('button[data-ansicht]');
  if (knopf) zeigeAnsicht(knopf.dataset.ansicht);
});

const band = $('#band');
let scrollTimer;
band.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const breite = band.clientWidth;
    if (!breite) return;
    const ort = alleOrte()[Math.round(band.scrollLeft / breite)];
    if (ort) setzeAktiv(ort.id);
  }, 120);
}, { passive: true });

band.addEventListener('click', (e) => {
  const knopf = e.target.closest('[data-aktion]');
  if (!knopf) return;
  const seite = knopf.closest('.seite');
  const ort = seite && ortMitId(seite.dataset.id);
  switch (knopf.dataset.aktion) {
    case 'neu':
      aktualisiere(ort, true);
      break;
    case 'warnung':
      if (ort && daten.get(ort.id)) oeffneWarnungen(daten.get(ort.id));
      break;
    case 'tag': {
      const schluessel = knopf.dataset.tag;
      const details = knopf.nextElementSibling;
      const offen = details.hidden;
      details.hidden = !offen;
      knopf.setAttribute('aria-expanded', String(offen));
      if (offen) offeneTage.add(schluessel); else offeneTage.delete(schluessel);
      break;
    }
    case 'zu-orte':
      zeigeAnsicht('orte');
      $('#suche').focus();
      break;
  }
});

$('#suche').addEventListener('input', (e) => {
  clearTimeout(suchTimer);
  suchTimer = setTimeout(() => suche(e.target.value), 300);
});
$('#suche').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const erster = $('#vorschlaege').treffer;
    if (erster && erster.length && !$('#vorschlaege').hidden) fuegeOrtHinzu(erster[0]);
  }
});
$('#vorschlaege').addEventListener('click', (e) => {
  const knopf = e.target.closest('button[data-treffer]');
  if (knopf) fuegeOrtHinzu($('#vorschlaege').treffer[Number(knopf.dataset.treffer)]);
});

$('#gps-schalter').addEventListener('change', (e) => {
  gpsAn = e.target.checked;
  schreibe(S_GPS, gpsAn);
  if (gpsAn) aktiveId = 'gps';
  baueBand();
  zeichneOrteListe();
  if (gpsAn) aktualisiere(ortMitId('gps'), true);
});

$('#orte-liste').addEventListener('click', (e) => {
  const knopf = e.target.closest('button[data-aktion]');
  if (!knopf) return;
  const id = knopf.dataset.id;
  const pos = orte.findIndex((o) => o.id === id);
  switch (knopf.dataset.aktion) {
    case 'oeffnen':
      aktiveId = id;
      schreibe(S_AKTIV, id);
      zeichnePunkte();
      radarZielGeaendert = true;
      zeigeAnsicht('wetter');
      aktualisiere(ortMitId(id));
      return;
    case 'hoch':
    case 'runter': {
      const ziel = knopf.dataset.aktion === 'hoch' ? pos - 1 : pos + 1;
      if (pos < 0 || ziel < 0 || ziel >= orte.length) return;
      [orte[pos], orte[ziel]] = [orte[ziel], orte[pos]];
      break;
    }
    case 'loeschen':
      if (pos < 0 || !confirm(`${orte[pos].name} aus der Liste entfernen?`)) return;
      orte.splice(pos, 1);
      daten.delete(id);
      entferne(S_DATEN + id);
      if (aktiveId === id) aktiveId = null;
      break;
  }
  speichereOrte();
  baueBand();
  zeichneOrteListe();
});

$('#radar-abspielen').addEventListener('click', () => (radarSpielt ? stoppeRadar() : spieleRadar()));
$('#radar-jetzt').addEventListener('click', () => { stoppeRadar(); zeigeBild(messIndex); });
$('#radar-regler').addEventListener('input', (e) => {
  if (radarSpielt) stoppeRadar();
  zeigeBild(Number(e.target.value));
});
$('#radar-mehr').addEventListener('click', (e) => {
  const optionen = $('#radar-optionen');
  optionen.hidden = !optionen.hidden;
  e.target.setAttribute('aria-expanded', String(!optionen.hidden));
  const legende = $('#radar-legende');
  if (!optionen.hidden && !legende.src) {
    legende.src = `${WMS}?service=WMS&version=1.3.0&request=GetLegendGraphic&format=image/png&layer=${RADAR_EBENE}`;
  }
});
$('#radar-warnungen').addEventListener('change', (e) => schalteWarnEbene(e.target.checked));

// Beim Zurückholen der App veraltete Daten neu laden.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    if (radarSpielt) stoppeRadar();
    return;
  }
  aktualisiere(aktiverOrt());
  if (ansicht === 'radar') bereiteRadarVor().catch(() => {});
});
window.addEventListener('online', () => aktualisiere(aktiverOrt()));

// ===================== Start =====================
$('#gps-schalter').checked = gpsAn;
baueBand();
zeichneOrteListe();
aktualisiere(aktiverOrt());

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ('serviceWorker' in navigator) {
  // Ist schon eine ältere Version aktiv, wird nach einem Update einmal neu geladen.
  const hatteVersion = Boolean(navigator.serviceWorker.controller);
  let neuGeladen = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hatteVersion || neuGeladen) return;
    if (document.querySelector('dialog[open]')) {
      zeigeStatus('Neue Version geladen. Sie ist beim nächsten Öffnen der App aktiv.');
      return;
    }
    neuGeladen = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((anmeldung) => {
    // Die installierte App bleibt oft im Hintergrund offen; beim Zurückholen nach Updates schauen.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') anmeldung.update().catch(() => {});
    });
  }).catch(() => {});
}
