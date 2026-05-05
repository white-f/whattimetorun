const STORAGE = {
  loc:      'wttr-loc-v1',
  range:    'wttr-range-v1',
  params:   'wttr-params-v1',
  unit:     'wttr-unit-v1',
  windUnit: 'wttr-wind-v1',
};

const DAY_OFFSETS = { today: 0, tomorrow: 1, '2days': 2 };

const DEFAULT_PARAMS = {
  wDaylight: 40, wTemp: 20, wPrecip: 20,
  wWind:     10, wHumidity: 5, wUV: 5,
  idealTemp: 10, windTol: 10,
  daylightOnly: true,
};

const HOURLY_FIELDS = [
  'temperature_2m', 'apparent_temperature', 'precipitation_probability',
  'precipitation', 'wind_speed_10m', 'relative_humidity_2m',
  'uv_index', 'is_day',
];

const HOUR_MS = 3600 * 1000;
const DAY_MS  = 24 * HOUR_MS;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const $ = (id) => document.getElementById(id);
const els = {
  cityInput:     $('cityInput'),
  suggestions:   $('suggestions'),
  locLabel:      $('locLabel'),
  dayBtns:       document.querySelectorAll('.day-btn'),
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
  unitToggle:    $('unitToggle'),
  windToggle:    $('windToggle'),
};

let currentRange = 'today';

const setRange = (r) => {
  currentRange = r;
  els.dayBtns.forEach(b => b.classList.toggle('active', b.dataset.range === r));
  localStorage.setItem(STORAGE.range, r);
};

const state = {
  params:          { ...DEFAULT_PARAMS },
  forecast:        null,
  loc:             null,
  useFahrenheit:   false,
  useImperialWind: false,
};

const toF   = (c)   => c * 9 / 5 + 32;
const toMs  = (kmh) => kmh / 3.6;
const toMph = (kmh) => kmh / 1.60934;

const displayTemp = (c) => state.useFahrenheit
  ? `${Math.round(toF(c))}°F`
  : `${Math.round(c)}°C`;
const displayWind = (kmh) => state.useImperialWind
  ? `${Math.round(toMph(kmh))} mph`
  : `${(toMs(kmh)).toFixed(1)} m/s`;

const displayParamValue = (id, val) => {
  if (id === 'idealTemp') return state.useFahrenheit  ? Math.round(toF(val))   : val;
  if (id === 'windTol')   return state.useImperialWind ? Math.round(toMph(val)) : toMs(val).toFixed(1);
  return val;
};

const tempScore     = (t, ideal) => 100 * Math.exp(-((t - ideal) ** 2) / 128);
const precipScore   = (prob, mm) => Math.max(0, 100 - prob - mm * 30);
const windScore     = (kmh, tol) => Math.max(0, 100 - Math.max(0, kmh - tol) * 4);
const uvScore       = (uv)       => Math.max(0, 100 - Math.max(0, uv - 3) * 20);
const humidityScore = (rh)       => Math.max(0, 100 - Math.max(0, Math.abs(rh - 55) - 15) * 2);
const daylightScore = (isDay)    => isDay ? 100 : 0;

function scoreHour(h, p) {
  const wDaylight = p.daylightOnly ? 0 : p.wDaylight;
  const total = wDaylight + p.wTemp + p.wPrecip + p.wWind + p.wHumidity + p.wUV;
  if (!total) return 0;
  return Math.round((
    tempScore(h.apparent, p.idealTemp)    * p.wTemp +
    precipScore(h.precipProb, h.precipMm) * p.wPrecip +
    windScore(h.wind, p.windTol)          * p.wWind +
    uvScore(h.uv)                         * p.wUV +
    humidityScore(h.humidity)             * p.wHumidity +
    daylightScore(h.isDay)                * wDaylight
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
  if (rainPct >= 40) items.push('rain jacket');
  if (windKmh >= 20) items.push('windbreaker');
  if (uv      >=  6) items.push('cap & sunglasses');
  return items.join(' · ');
}

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

function topWindows(hours, n = 3) {
  return hours
    .filter(h => h.score >= 35)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map(h => ({ avg: h.score, hours: [h] }));
}

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
        <div class="pick-score">${p.avg}</div>
        <div class="when">${first.dayLabel}, ${range}</div>
        <div class="verdict">${verdict(p.avg)}</div>
        <div class="stats">
          <span><b>${displayTemp(apparent)}</b> feels-like</span>
          <span><b>${displayWind(wind)}</b> wind</span>
          <span><b>${Math.round(rain)}%</b> rain</span>
          <span><b>UV ${uv.toFixed(1)}</b></span>
        </div>
        <div class="wear">Kit: ${wearAdvice(apparent, rain, wind, uv)}</div>
      </div>`;
  }).join('');
}

function renderHours(hours) {
  els.hours.innerHTML = hours.map(h => {
    const t = tier(h.score);
    return `
      <div class="hour s-${t}"
        data-temp="${Math.round(h.temp)}"
        data-apparent="${Math.round(h.apparent)}"
        data-wind="${Math.round(h.wind)}"
        data-rain="${Math.round(h.precipProb)}"
        data-humidity="${Math.round(h.humidity)}"
        data-uv="${h.uv.toFixed(1)}"
        data-score="${h.score}">
        <div class="hr-score">${h.score}</div>
        <div class="hr-temp">${displayTemp(h.apparent)}</div>
        <div class="hr-label">${fmtHour(h.ts)}</div>
      </div>`;
  }).join('');
}

const tooltip = $('tooltip');

els.hours.addEventListener('mouseover', (e) => {
  const hour = e.target.closest('.hour');
  if (!hour) return;
  const d = hour.dataset;
  tooltip.innerHTML =
    `<div class="tt-row"><span>Feels like</span><b>${displayTemp(+d.apparent)}</b></div>` +
    `<div class="tt-row"><span>Actual</span><b>${displayTemp(+d.temp)}</b></div>` +
    `<div class="tt-row"><span>Wind</span><b>${displayWind(+d.wind)}</b></div>` +
    `<div class="tt-row"><span>Rain</span><b>${d.rain}%</b></div>` +
    `<div class="tt-row"><span>Humidity</span><b>${d.humidity}%</b></div>` +
    `<div class="tt-row"><span>UV</span><b>${d.uv}</b></div>` +
    `<div class="tt-row"><span>Score</span><b>${d.score}</b></div>`;
  tooltip.hidden = false;
  positionTooltip(hour);
});

els.hours.addEventListener('mouseleave', () => { tooltip.hidden = true; });

function positionTooltip(anchor) {
  const r = anchor.getBoundingClientRect();
  const tw = tooltip.offsetWidth;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  tooltip.style.left = `${left + window.scrollX}px`;
  tooltip.style.top  = `${r.top + window.scrollY - tooltip.offsetHeight - 8}px`;
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

function rerender() {
  if (!state.forecast) return;
  els.hourlyHeading.textContent =
    document.querySelector('.day-btn.active')?.textContent || 'Forecast';
  const hours = buildHours(state.forecast, state.params, currentRange);
  if (!hours.length) {
    showStatus('No forecast hours for the selected day.');
    return;
  }
  renderPicks(topWindows(hours));
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
    if (out && input?.type !== 'checkbox') out.textContent = displayParamValue(id, state.params[id]);
  }
  syncDaylightSlider();
  syncUnitUI();
}

function syncUnitUI() {
  const unitSpan = $('idealTempUnit');
  if (unitSpan) unitSpan.textContent = state.useFahrenheit ? '°F' : '°C';
  if (els.unitToggle) els.unitToggle.classList.toggle('active', state.useFahrenheit);

  const windUnitSpan = $('windTolUnit');
  if (windUnitSpan) windUnitSpan.textContent = state.useImperialWind ? ' mph' : ' m/s';
  if (els.windToggle) els.windToggle.classList.toggle('active', state.useImperialWind);
}

function syncDaylightSlider() {
  const disabled = !!state.params.daylightOnly;
  const input = $('wDaylight');
  const row   = input?.closest('.param');
  if (input) input.disabled = disabled;
  if (row)   row.style.opacity = disabled ? '0.4' : '';
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
        if (out) out.textContent = displayParamValue(id, parseFloat(input.value));
      }
      if (isCheck) syncDaylightSlider();
      persistParams();
      rerender();
    });
  }
}

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function init() {
  state.params = { ...DEFAULT_PARAMS, ...loadJSON(STORAGE.params, {}) };
  const locale = navigator.language;
  const savedUnit = localStorage.getItem(STORAGE.unit);
  state.useFahrenheit = savedUnit !== null
    ? savedUnit === 'F'
    : /^en-US\b/i.test(locale);
  const savedWind = localStorage.getItem(STORAGE.windUnit);
  state.useImperialWind = savedWind !== null
    ? savedWind === 'mph'
    : /^en-US\b/i.test(locale);
  syncParamsToUI();

  const twoDaysBtn = document.querySelector('.day-btn[data-range="2days"]');
  if (twoDaysBtn) twoDaysBtn.textContent = WEEKDAYS[new Date(Date.now() + 2 * DAY_MS).getDay()];

  const savedRange = localStorage.getItem(STORAGE.range);
  if (savedRange && savedRange in DAY_OFFSETS) setRange(savedRange);

  els.cityInput.addEventListener('input', onCityInput);
  els.suggestions.addEventListener('click', onSuggestionClick);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.location')) els.suggestions.hidden = true;
  });

  els.dayBtns.forEach(b => b.addEventListener('click', () => {
    setRange(b.dataset.range);
    rerender();
  }));

  els.unitToggle?.addEventListener('click', () => {
    state.useFahrenheit = !state.useFahrenheit;
    localStorage.setItem(STORAGE.unit, state.useFahrenheit ? 'F' : 'C');
    syncParamsToUI();
    rerender();
  });

  els.windToggle?.addEventListener('click', () => {
    state.useImperialWind = !state.useImperialWind;
    localStorage.setItem(STORAGE.windUnit, state.useImperialWind ? 'mph' : 'kmh');
    syncParamsToUI();
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
