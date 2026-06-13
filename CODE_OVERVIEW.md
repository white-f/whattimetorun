# Code Overview — "When to run?"

A single-page weather app that recommends the best hours to go running, built with
vanilla HTML/CSS/JS and the free [Open-Meteo](https://open-meteo.com/) APIs.

## Overall architecture

Three files, no build step, no dependencies:

- `index.html` — structure (a settings panel + main content area)
- `styles.css` — all styling, dark/light themes, responsive
- `script.js` — all logic: fetch weather → score each hour → render

The data flow is: **user picks a city → fetch 3-day hourly forecast → score every
hour 0–100 by how good it is for running → render the top 3 "windows" + an hourly
grid.** Whenever settings change, it re-scores and re-renders from the already-fetched
data (no new network call).

---

## index.html

**Settings panel** (lines 10–84) — a gear button (`#paramsBtn`) opens an `<aside>`
panel. It contains:

- Two unit toggles (°C/°F, m/s/mph) — styled as sliding switches.
- Six **scoring weight sliders** (`wDaylight`, `wTemp`, `wPrecip`, `wWind`,
  `wHumidity`, `wUV`) — these control how much each weather factor matters. Each has
  a `data-out` span showing its live value.
- Two **preference sliders**: `idealTemp` (your ideal feels-like temp) and `windTol`
  (wind tolerance).
- A `daylightOnly` checkbox and a reset button.

**Main area** (lines 86–133):

- City search input + `#suggestions` dropdown.
- Three day buttons (Today / Tomorrow / +2 days) with `data-range` attributes.
- `#status` for messages, `#topPicks` for the best windows, `#hourly` for the
  hour-by-hour grid + a color legend.

The `#tooltip` div (line 134) sits at the end, positioned dynamically on hover. The
`data-out`/`data-range`/`id` attributes are the contract between HTML and JS.

---

## script.js — top to bottom

### Configuration (lines 1–26)

- `STORAGE` — localStorage keys (versioned with `-v1`) for persisting location,
  selected day, params, and unit choices.
- `DAY_OFFSETS` — maps `'today'/'tomorrow'/'2days'` to `0/1/2` day offsets.
- `DEFAULT_PARAMS` — default scoring weights and preferences. Weights sum to 100 by
  default (40+20+20+10+5+5).
- `HOURLY_FIELDS` — exactly the weather variables requested from the API.
- Time constants and `WEEKDAYS`.

### DOM references & state (lines 28–62)

- `$` is a `getElementById` shorthand; `els` caches every element used.
- `state` holds everything mutable: selected `range`, `params`, the fetched
  `forecast`, current `loc`, and the two unit booleans.
- `setRange` updates state, toggles the active button styling, and persists the choice.

### Unit conversion & display (lines 64–79)

- `toF`, `toMs`, `toMph` — pure converters. **Important:** internally everything is
  metric (°C, km/h — the API's native units). Conversion happens *only at display
  time*.
- `displayTemp`/`displayWind` — format a metric value into the user's chosen unit.
- `displayParamValue` — special-cases the two sliders whose values are
  temperature/wind so the settings panel shows them in the right unit.

### The scoring system (lines 81–100) — the heart of the app

Six independent scoring functions, each returning 0–100:

- `tempScore` — a **Gaussian curve** peaking at your `idealTemp`:
  `100 * exp(-(t-ideal)²/128)`. The further feels-like temp is from ideal (in either
  direction), the lower the score.
- `precipScore` — `100 − probability% − mm×30`, clamped at 0. Both likelihood and
  amount of rain hurt.
- `windScore` — full marks until wind exceeds your tolerance, then drops 4 points per
  km/h over.
- `uvScore` — full marks up to UV 3, then −20 per point.
- `humidityScore` — full marks within 40–70% RH, penalized outside that comfortable
  band.
- `daylightScore` — 100 if daytime, 0 if not.

`scoreHour` combines them as a **weighted average**. Key detail (line 89): if
`daylightOnly` is on, the daylight weight is forced to 0 (since all shown hours are
already daytime, it'd be redundant). The `if (!total) return 0` guards against
all-zero weights (division by zero).

### Labels (lines 102–124)

- `tier` → `great/good/ok/bad` (drives the color class).
- `verdict` → human sentence.
- `wearAdvice` → an if/else ladder turning feels-like temp into clothing suggestions,
  plus add-ons for rain/wind/UV. This is the "Kit:" line on each pick card.

### API calls (lines 126–145)

- `searchCities` — Open-Meteo geocoding; returns up to 6 matches. Returns `[]` on
  failure.
- `fetchForecast` — requests 3 days of hourly data with `timezone: 'auto'`, so times
  come back in the *location's* local wall-clock.

### Time handling (lines 147–159) — the subtle part

The API returns naive local strings like `"2026-06-13T14:00"` (no timezone).
`naiveOf` appends `'Z'` to parse them **as if UTC**. This is a deliberate trick: by
treating local wall-clock as UTC and always reading back with `getUTC*` methods, the
displayed time matches the location's clock **regardless of the browser's own
timezone**. `dayKey` and `fmtHour` both use UTC getters to stay consistent with this
scheme.

### Building the hour list (lines 160–201)

`buildHours` is the bridge from raw API data to scored hour objects:

- Computes `nowNaive` (current time at the *location*) by adding the API's
  `utc_offset_seconds`.
- Finds the start/end of the selected day. For "today," the lower bound is
  `now − 30 min` so the current hour isn't dropped; for future days it's midnight.
- Loops through API hours, skipping anything before the window (`continue`), stopping
  at the end (`break` — safe because the API returns chronological data), and skipping
  nighttime hours when `daylightOnly` is set.
- Builds a flat hour object, scores it, and collects it.

### Selecting & rendering (lines 204–253)

- `topWindows` — filters to score ≥ 35, sorts descending, takes top 3.
- `renderPicks` — builds the "Best windows" cards with score, time range, verdict,
  stats, and kit advice. Shows a fallback message if empty.
- `renderHours` — builds the hourly grid. Each tile stashes full detail in `data-*`
  attributes for the tooltip to read.

### Tooltip (lines 255–280)

Event delegation on the hours container: `mouseover` finds the closest `.hour`, reads
its `data-*` attributes, fills and positions the tooltip; `mouseleave` hides it.
`positionTooltip` centers it above the tile and clamps it to stay on-screen.
(Mouse-only — doesn't fire on touch.)

### View orchestration (lines 282–329)

- `showStatus`/`showResults` — toggle which sections are visible.
- `rerender` — the central refresh: rebuilds hours from cached forecast + current
  params/range and re-renders. Called on *any* settings change — no refetch needed.
- `loadFor` — the only function that fetches: stores location, shows a loading
  message, fetches, persists, and renders (with error handling here).

### City search UI (lines 322–349)

- `escapeHtml` — escapes `& < > " '` before injecting API-supplied city names into
  `innerHTML`.
- `onCityInput` — debounced 250ms search; renders suggestion `<li>`s with
  lat/lon/label in data attributes.
- `onSuggestionClick` — event delegation; reads the clicked city's data and calls
  `loadFor`. (The HTML entities in `data-label` auto-decode when read back via
  `.dataset`.)

### Settings sync (lines 351–415)

- `syncParamsToUI` — pushes `state.params` into the inputs and their display spans.
- `syncUnitUI` — updates unit labels and toggle styling.
- `syncDaylightSlider` — disables/dims the daylight-weight slider when `daylightOnly`
  is checked (since it has no effect then).
- `bindParamInputs` — wires every slider/checkbox to update state, refresh its
  display, persist, and `rerender` on change.

### Initialization (lines 413–474)

`init` ties it all together:

- Merges saved params over defaults.
- **Locale-aware unit defaults**: if no saved preference, defaults to Fahrenheit/mph
  only for `en-US`, metric everywhere else.
- Relabels the "+2 days" button with the actual weekday name.
- Restores the saved day range.
- Wires up all event listeners (search, day buttons, unit toggles, panel open/close,
  reset).
- If a location was saved from a previous visit, auto-loads its forecast.

Then `init()` runs immediately (line 474).

---

## styles.css

- **Theming** (lines 1–24): CSS custom properties define the palette; a
  `prefers-color-scheme: light` block overrides them — so dark/light follows the OS
  automatically, no JS.
- **Layout**: `main` is a centered 760px column. The search, day buttons
  (pill-shaped), and suggestion dropdown (absolutely positioned) make up the location
  section.
- **Unit switches** (lines 141–188): the °C/°F toggle is a pure-CSS sliding switch — a
  `::before` pseudo-element slides via `transform: translateX(100%)` when `.active`,
  and the two `<span>` labels swap colors.
- **Cards**: `.pick` cards use a colored left border + score badge tied to the tier
  class (`.s-great`/`.s-good`/`.s-ok`/`.s-bad`). `.hour` tiles are a responsive
  auto-fill grid.
- **Settings panel** (lines 385–397): a fixed right-side drawer on desktop.
- **Responsive** (lines 495–540): below 520px the panel becomes a **bottom sheet**
  (with a drag-handle bar), picks go single-column, and hour tiles get larger touch
  targets.

---

**In one sentence:** it fetches a 3-day hourly forecast, runs each hour through six
weather-quality curves combined into a personalized weighted score, and presents the
best running windows plus a browsable hourly grid — all client-side, persisted in
localStorage, with no backend or build tooling.
