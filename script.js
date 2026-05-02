// ---------- config ----------

const STORAGE = {
  loc:    'wttr-loc-v1',
  range:  'wttr-range-v1',
  params: 'wttr-params-v1',
};

const DAY_OFFSETS = { today: 0, tomorrow: 1, '2days': 2 };
const DAY_LABELS  = { today: 'Today', tomorrow: 'Tomorrow', '2days': 'Day after tomorrow' };

const DEFAULT_PARAMS = {
  wDaylight: 40, wTemp: 20, wPrecip: 20,
  wWind:     10, wHumidity: 5, wUV: 5,
  idealTemp: 10, windTol: 10, windowHours: 1,
  daylightOnly: true,
};

const HOURLY_FIELDS = [
  'temperature_2m', 'apparent_temperature', 'precipitation_probability',
  'precipitation', 'wind_speed_10m', 'relative_humidity_2m',
  'uv_index', 'is_day',
];

const HOUR_MS = 3600 * 1000;
const DAY_MS  = 24 * HOUR_MS;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- DOM ----------

const $ = (id) => document.getElementById(id);
const els = {
  cityInput:     $('cityInput'),
  suggestions:   $('suggestions'),
  locLabel:      $('locLabel'),
  rangeSelect:   $('rangeSelect'),
  hourlyHeading: $('hourlyHeading'),
  status:        $('status'),
  topPicks:      $('topPicks'),
  picks:         $('picks'),
  hourly:        $('hourly'),
  hours:         $('hours'),
  paramsBtn:     $('paramsBtn'),
  paramsPanel:   $('paramsPanel'),
  paramsClose:   $('paramsClose'),
  paramsReset:   $('paramsReset'),
};

// ---------- state ----------

const state = {
  params:   { ...DEFAULT_PARAMS },
  forecast: null,
  loc:      null,
};

// ---------- scoring ----------

const tempScore     = (t, ideal) => 100 * Math.exp(-((t - ideal) ** 2) / 128);
const precipScore   = (prob, mm) => Math.max(0, 100 - (prob || 0) - (mm || 0) * 30);
const windScore     = (kmh, tol) => Math.max(0, 100 - Math.max(0, kmh - tol) * 4);
const uvScore       = (uv)       => Math.max(0, 100 - Math.max(0, uv - 3) * 20);
const humidityScore = (rh)       => Math.max(0, 100 - Math.max(0, Math.abs(rh - 55) - 15) * 2);
const daylightScore = (isDay)    => isDay ? 100 : 0;

function scoreHour(h, p) {
  const total = p.wDaylight + p.wTemp + p.wPrecip + p.wWind + p.wHumidity + p.wUV;
  if (!total) return 0;
  return Math.round((
    tempScore(h.apparent, p.idealTemp)    * p.wTemp +
    precipScore(h.precipProb, h.precipMm) * p.wPrecip +
    windScore(h.wind, p.windTol)          * p.wWind +
    uvScore(h.uv)                         * p.wUV +
    humidityScore(h.humidity)             * p.wHumidity +
    daylightScore(h.isDay)                * p.wDaylight
  ) / total);
}

const tier = (s) =>
  s >= 75 ? 'great' : s >= 60 ? 'good' : s >= 45 ? 'ok' : 'bad';

const verdict = (s) =>
  s >= 75 ? 'Great running conditions' :
  s >= 60 ? 'Good — go for it'        :
  s >= 45 ? 'OK, not perfect'         : 'Skip if you can';

function wearAdvice(apparent, rainPct, windKmh, uv) {
  const items = [];
  if      (apparent < -5) items.push('thermal jacket, tights, hat, gloves');
  else if (apparent <  0) items.push('thermal long sleeve, tights, gloves');
  else if (apparent <  5) items.push('long sleeve, tights, light gloves');
  else if (apparent < 10) items.push('long sleeve, tights or capris');
  else if (apparent < 15) items.push('t-shirt or long sleeve, shorts');
  else if (apparent < 20) items.push('t-shirt, shorts');
  else if (apparent < 25) items.push('singlet, shorts');
  else                    items.push('singlet, shorts — hydrate');
  if (rainPct  >= 40) items.push('rain jacket');
  if (windKmh  >= 20) items.push('windbreaker');
  if (uv       >=  6) items.push('cap & sunglasses');
  return items.join(' · ');
}


// ---------- API ----------

async function searchCities(q) {
  if (q.length < 2) return [];
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) return [];
  return (await res.json()).results || [];
}

async function fetchForecast(lat, lon) {
  const qs = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: HOURLY_FIELDS.join(','),
    timezone: 'auto',
    forecast_days: 3,
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${qs}`);
  if (!res.ok) throw new Error(`Weather API ${res.status}`);
  return res.json();
}

// ---------- time ----------

// Open-Meteo returns local wall-clock strings. We store them as "naive" UTC ms
// so display reads back the same wall clock regardless of the browser's tz.
const naiveOf = (isoLocal) => new Date(isoLocal + 'Z').getTime();

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
};

const fmtHour = (ts) => {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

// ---------- forecast → hours ----------

function buildHours(data, params, rangeKey) {
  const offsetMs = (data.utc_offset_seconds || 0) * 1000;
  const nowNaive = Date.now() + offsetMs;
  const days     = DAY_OFFSETS[rangeKey] ?? 0;

  const ref   = new Date(nowNaive + days * DAY_MS);
  const start = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
  const end   = start + DAY_MS;
  const lower = days === 0 ? Math.max(start, nowNaive - 30 * 60 * 1000) : start;

  const todayK    = dayKey(nowNaive);
  const tomorrowK = dayKey(nowNaive + DAY_MS);
  const labelFor  = (ts, k) =>
    k === todayK    ? 'Today'    :
    k === tomorrowK ? 'Tomorrow' : WEEKDAYS[new Date(ts).getUTCDay()];

  const h = data.hourly;
  const out = [];
  for (let i = 0; i < h.time.length; i++) {
    const ts = naiveOf(h.time[i]);
    if (ts < lower) continue;
    if (ts >= end)  break;
    if (params.daylightOnly && !h.is_day[i]) continue;
    const k = dayKey(ts);
    const hour = {
      ts,
      dayKey:     k,
      dayLabel:   labelFor(ts, k),
      temp:       h.temperature_2m[i],
      apparent:   h.apparent_temperature[i],
      precipProb: h.precipitation_probability[i] ?? 0,
      precipMm:   h.precipitation[i] ?? 0,
      wind:       h.wind_speed_10m[i],
      humidity:   h.relative_humidity_2m[i],
      uv:         h.uv_index[i] ?? 0,
      isDay:      !!h.is_day[i],
    };
    hour.score = scoreHour(hour, params);
    out.push(hour);
  }
  return out;
}

// ---------- top windows ----------

function topWindows(hours, lenHours, n = 3) {
  const len = Math.max(1, lenHours | 0);
  const candidates = [];
  outer: for (let i = 0; i + len - 1 < hours.length; i++) {
    let sum = 0;
    for (let j = 0; j < len; j++) {
      if (j > 0 && hours[i + j].ts - hours[i + j - 1].ts !== HOUR_MS) continue outer;
      sum += hours[i + j].score;
    }
    candidates.push({
      avg:   Math.round(sum / len),
      hours: hours.slice(i, i + len),
    });
  }
  return candidates
    .filter(c => c.avg >= 35)
    .sort((x, y) => y.avg - x.avg)
    .slice(0, n);
}

// ---------- rendering ----------

function renderPicks(picks) {
  if (!picks.length) {
    els.picks.innerHTML =
      '<div class="status">No good running windows for the selected day.</div>';
    return;
  }
  const mean = (arr, key) => arr.reduce((s, x) => s + x[key], 0) / arr.length;
  const max  = (arr, key) => arr.reduce((m, x) => Math.max(m, x[key]), -Infinity);
  els.picks.innerHTML = picks.map(p => {
    const first    = p.hours[0];
    const last     = p.hours[p.hours.length - 1];
    const t        = tier(p.avg);
    const range    = `${fmtHour(first.ts)} – ${fmtHour(last.ts + HOUR_MS)}`;
    const apparent = mean(p.hours, 'apparent');
    const wind     = mean(p.hours, 'wind');
    const rain     = max(p.hours, 'precipProb');
    const uv       = max(p.hours, 'uv');
    return `
      <div class="pick s-${t}">
        <div class="when">${first.dayLabel}, ${range}</div>
        <div class="verdict">${verdict(p.avg)} · score ${p.avg}</div>
        <div class="stats">
          <span><b>${Math.round(apparent)}°C</b> feels-like</span>
          <span><b>${Math.round(wind)}</b> km/h wind</span>
          <span><b>${Math.round(rain)}%</b> rain</span>
          <span><b>UV ${uv.toFixed(1)}</b></span>
        </div>
        <div class="wear">Wear: ${wearAdvice(apparent, rain, wind, uv)}</div>
      </div>`;
  }).join('');
}

function renderHours(hours) {
  let lastKey = null;
  els.hours.innerHTML = hours.map(h => {
    const t      = tier(h.score);
    const newDay = lastKey && h.dayKey !== lastKey;
    lastKey = h.dayKey;
    const tooltip =
      `${h.dayLabel} ${fmtHour(h.ts)} · score ${h.score}\n` +
      `${Math.round(h.temp)}°C (feels ${Math.round(h.apparent)}°C)\n` +
      `wind ${Math.round(h.wind)} km/h · rain ${Math.round(h.precipProb)}%\n` +
      `humidity ${Math.round(h.humidity)}% · UV ${h.uv.toFixed(1)}`;
    return `
      <div class="hour s-${t}${newDay ? ' day-divider' : ''}" title="${tooltip}">
        <div class="hr-label">${fmtHour(h.ts)}</div>
        <div class="hr-temp">${Math.round(h.apparent)}°</div>
        <div class="hr-bar"><div style="width:${h.score}%"></div></div>
      </div>`;
  }).join('');
}

function showStatus(message) {
  els.status.textContent = message;
  els.status.hidden = false;
  els.topPicks.hidden = true;
  els.hourly.hidden   = true;
}

function showResults() {
  els.status.hidden   = true;
  els.topPicks.hidden = false;
  els.hourly.hidden   = false;
}

// ---------- flow ----------

function rerender() {
  if (!state.forecast) return;
  els.hourlyHeading.textContent = DAY_LABELS[els.rangeSelect.value] || 'Forecast';
  const hours = buildHours(state.forecast, state.params, els.rangeSelect.value);
  if (!hours.length) {
    showStatus('No forecast hours for the selected day.');
    return;
  }
  renderPicks(topWindows(hours, state.params.windowHours));
  renderHours(hours);
  showResults();
}

async function loadFor(lat, lon, label) {
  state.loc = { lat, lon, label };
  els.locLabel.textContent = label;
  showStatus('Loading forecast...');
  try {
    state.forecast = await fetchForecast(lat, lon);
    localStorage.setItem(STORAGE.loc, JSON.stringify(state.loc));
    rerender();
  } catch (e) {
    showStatus(`Couldn't load forecast: ${e.message}`);
  }
}

// ---------- city search ----------

const escapeAttr = (s) => s.replace(/"/g, '&quot;');
let searchTimer = null;

function onCityInput() {
  const q = els.cityInput.value.trim();
  clearTimeout(searchTimer);
  if (q.length < 2) { els.suggestions.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    const results = await searchCities(q);
    if (!results.length) { els.suggestions.hidden = true; return; }
    els.suggestions.innerHTML = results.map(r => {
      const sub   = [r.admin1, r.country].filter(Boolean).join(', ');
      const label = `${r.name}${sub ? ', ' + sub : ''}`;
      return `<li data-lat="${r.latitude}" data-lon="${r.longitude}" data-label="${escapeAttr(label)}">${r.name} <small>${sub}</small></li>`;
    }).join('');
    els.suggestions.hidden = false;
  }, 250);
}

function onSuggestionClick(e) {
  const li = e.target.closest('li');
  if (!li) return;
  els.suggestions.hidden = true;
  els.cityInput.value = li.dataset.label;
  loadFor(parseFloat(li.dataset.lat), parseFloat(li.dataset.lon), li.dataset.label);
}

// ---------- params panel ----------

const PARAM_IDS = Object.keys(DEFAULT_PARAMS);
const paramOut  = (id) => document.querySelector(`[data-out="${id}"]`);

function syncParamsToUI() {
  for (const id of PARAM_IDS) {
    const input = $(id);
    const out   = paramOut(id);
    if (input) {
      if (input.type === 'checkbox') input.checked = !!state.params[id];
      else input.value = state.params[id];
    }
    if (out && input?.type !== 'checkbox') out.textContent = state.params[id];
  }
}

function persistParams() {
  localStorage.setItem(STORAGE.params, JSON.stringify(state.params));
}

function bindParamInputs() {
  for (const id of PARAM_IDS) {
    const input = $(id);
    if (!input) continue;
    const isCheck = input.type === 'checkbox';
    input.addEventListener(isCheck ? 'change' : 'input', () => {
      state.params[id] = isCheck ? input.checked : parseFloat(input.value);
      if (!isCheck) {
        const out = paramOut(id);
        if (out) out.textContent = input.value;
      }
      persistParams();
      rerender();
    });
  }
}

// ---------- bootstrap ----------

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function init() {
  state.params = { ...DEFAULT_PARAMS, ...(loadJSON(STORAGE.params, {}) || {}) };
  syncParamsToUI();

  const savedRange = localStorage.getItem(STORAGE.range);
  if (savedRange && savedRange in DAY_OFFSETS) els.rangeSelect.value = savedRange;

  els.cityInput.addEventListener('input', onCityInput);
  els.suggestions.addEventListener('click', onSuggestionClick);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.location')) els.suggestions.hidden = true;
  });

  els.rangeSelect.addEventListener('change', () => {
    localStorage.setItem(STORAGE.range, els.rangeSelect.value);
    rerender();
  });

  els.paramsBtn.addEventListener('click',   () => els.paramsPanel.hidden = false);
  els.paramsClose.addEventListener('click', () => els.paramsPanel.hidden = true);
  els.paramsReset.addEventListener('click', () => {
    state.params = { ...DEFAULT_PARAMS };
    syncParamsToUI();
    persistParams();
    rerender();
  });
  bindParamInputs();

  const saved = loadJSON(STORAGE.loc, null);
  if (saved) {
    els.cityInput.value = saved.label;
    loadFor(saved.lat, saved.lon, saved.label);
  }
}

init();
