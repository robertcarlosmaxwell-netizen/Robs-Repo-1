/* ---------- Storage ---------- */
const STORAGE_KEY = 'wt_sessions_v1';
const ROUTINES_KEY = 'wt_routines_v1';
const ACTIVE_WORKOUT_KEY = 'wt_active_workout_v1';
const EXERCISE_LIBRARY_KEY = 'wt_exercise_library_v1';
const BODYWEIGHT_KEY = 'wt_bodyweight_v1';
const SYNC_CONFIG_KEY = 'wt_sync_config_v1';

function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load sessions', e);
    return [];
  }
}

function saveSessions(sessions) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

function loadRoutines() {
  try {
    const raw = localStorage.getItem(ROUTINES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load routines', e);
    return [];
  }
}

function saveRoutines(routines) {
  localStorage.setItem(ROUTINES_KEY, JSON.stringify(routines));
}

// The in-progress workout (if any) is persisted continuously so a locked phone,
// backgrounded browser, or page reload doesn't lose the timer or logged sets.
function loadActiveWorkout() {
  try {
    const raw = localStorage.getItem(ACTIVE_WORKOUT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error('Failed to load active workout', e);
    return null;
  }
}

function saveActiveWorkout(activeWorkout, draftExercises) {
  localStorage.setItem(ACTIVE_WORKOUT_KEY, JSON.stringify({ activeWorkout, draftExercises }));
}

function clearActiveWorkoutStorage() {
  localStorage.removeItem(ACTIVE_WORKOUT_KEY);
}

function loadExerciseLibrary() {
  try {
    const raw = localStorage.getItem(EXERCISE_LIBRARY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load exercise library', e);
    return [];
  }
}

function saveExerciseLibrary(list) {
  localStorage.setItem(EXERCISE_LIBRARY_KEY, JSON.stringify(list));
}

/* Body weight log. One entry per date — logging the same date again replaces it,
   so there is never more than one weigh-in per day to average over. */
function loadBodyWeights() {
  try {
    const raw = localStorage.getItem(BODYWEIGHT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.error('Failed to load body weights', e);
    return [];
  }
}

function saveBodyWeights(list) {
  localStorage.setItem(BODYWEIGHT_KEY, JSON.stringify(list));
}

/* Cloud sync settings. The Apps Script URL is a write capability for the
   spreadsheet, so it is entered on the device and kept in localStorage —
   never committed to the (public) repo. */
function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    return {
      url: cfg.url || '',
      token: cfg.token || '',
      lastSyncedAt: cfg.lastSyncedAt || null,
      lastError: cfg.lastError || null,
    };
  } catch (e) {
    console.error('Failed to load sync config', e);
    return { url: '', token: '', lastSyncedAt: null, lastError: null };
  }
}

function saveSyncConfig(cfg) {
  localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(cfg));
}

// Normalize routines to { id, name, exercises: [{ name, sets, exerciseId }] }.
// Older saved routines stored exercises as plain strings — upgrade them in place.
function normalizeRoutine(r) {
  return {
    id: r.id,
    name: r.name,
    exercises: (r.exercises || []).map(e =>
      typeof e === 'string'
        ? { name: e, sets: 3, exerciseId: null }
        : { name: e.name, sets: Number(e.sets) || 3, exerciseId: e.exerciseId || null }
    ),
  };
}

// Older saved libraries stored exercises as plain strings — give them stable IDs.
// `inverted` marks exercises where a HIGHER logged number means you were WEAKER —
// assisted pull-up/chin-up machines, where the number is how much weight the machine
// takes off you. Without this the charts read exactly backwards for those lifts.
// `kind` is 'strength' (weight x reps) or 'cardio' (time / distance / incline).
// Anything saved before cardio existed has no kind and defaults to strength.
function normalizeExerciseLibrary(list) {
  return (list || []).map(e => (
    typeof e === 'string'
      ? { id: uid(), name: e, inverted: false, kind: 'strength' }
      : { ...e, inverted: !!e.inverted, kind: e.kind === 'cardio' ? 'cardio' : 'strength' }
  ));
}

/* ---------- Cardio helpers ----------
   A cardio bout is { minutes, distanceMi, inclinePct }. Speed and pace are always
   derived rather than stored, so they can never drift out of sync with the inputs. */
function isCardioExerciseName(name) {
  const entry = findExerciseByName(name);
  return !!(entry && entry.kind === 'cardio');
}

// A logged exercise knows its own kind, so history stays readable even if the
// library entry is later deleted or switched.
function exerciseIsCardio(ex) {
  if (ex && ex.kind) return ex.kind === 'cardio';
  return isCardioExerciseName(ex && ex.name);
}

/* Duration is stored as whole seconds. Bouts logged before that change stored
   decimal `minutes` instead, so read either shape and never migrate the data —
   there is nothing to go wrong at load time that way. */
function boutSeconds(bout) {
  if (!bout) return 0;
  if (bout.seconds !== undefined && bout.seconds !== null && bout.seconds !== '') {
    return Number(bout.seconds) || 0;
  }
  return Math.round((Number(bout.minutes) || 0) * 60);
}

function cardioSeconds(sets) {
  return (sets || []).reduce((sum, s) => sum + boutSeconds(s), 0);
}

// Everything downstream (charts, pace, the spreadsheet) still thinks in decimal
// minutes; only the input and the display are mm:ss.
function cardioMinutes(sets) {
  return cardioSeconds(sets) / 60;
}

function cardioDistance(sets) {
  return (sets || []).reduce((sum, s) => sum + (Number(s.distanceMi) || 0), 0);
}

function cardioSpeedMph(sets) {
  const min = cardioMinutes(sets);
  if (!min) return 0;
  return cardioDistance(sets) / (min / 60);
}

// Weighted by time so a long easy stretch doesn't get averaged against a short hill.
function cardioAvgIncline(sets) {
  const list = (sets || []).filter(s => boutSeconds(s) > 0);
  if (!list.length) return 0;
  const total = list.reduce((sum, s) => sum + boutSeconds(s), 0);
  return list.reduce((sum, s) => sum + (Number(s.inclinePct) || 0) * boutSeconds(s), 0) / total;
}

function fmtPace(minutesPerMile) {
  if (!isFinite(minutesPerMile) || minutesPerMile <= 0) return '—';
  const m = Math.floor(minutesPerMile);
  const s = Math.round((minutesPerMile - m) * 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
}

function cardioPace(sets) {
  const dist = cardioDistance(sets);
  return dist > 0 ? cardioMinutes(sets) / dist : 0;
}

// One-line summary used on the PREV banner, history cards and the workout screen.
function cardioSummary(sets) {
  const secs = cardioSeconds(sets);
  if (!secs) return '';
  const dist = cardioDistance(sets);
  const incline = cardioAvgIncline(sets);
  const bits = [formatDuration(secs)];
  if (dist > 0) bits.push(`${(Math.round(dist * 100) / 100).toFixed(2)} mi`);
  if (incline > 0) bits.push(`${Math.round(incline * 10) / 10}% incline`);
  if (dist > 0) bits.push(`${fmtPace(cardioPace(sets))}/mi`);
  return bits.join(' · ');
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function todayStr() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 10);
}

/* ---------- Volume calculations ----------
   Volume load is weight x reps. Cardio has neither, so it contributes zero and is
   excluded from session totals — otherwise a treadmill warm-up would silently
   dilute the number that's supposed to track lifting. */
function exerciseVolume(exercise) {
  if (exerciseIsCardio(exercise)) return 0;
  return setsToVolume(exercise.sets);
}

function sessionVolume(session) {
  return session.exercises.reduce((sum, ex) => sum + exerciseVolume(ex), 0);
}

// Total treadmill/bike time in a session, for the history card subtitle.
function sessionCardioMinutes(session) {
  return session.exercises.reduce(
    (sum, ex) => sum + (exerciseIsCardio(ex) ? cardioMinutes(ex.sets) : 0), 0);
}

/* ---------- Exercise identity (library IDs) ---------- */
// These helpers are the single source of truth for "is this the same exercise",
// so that renaming a library exercise correctly relabels it everywhere it's linked,
// while exercises that were never added to the library (declined the save prompt)
// keep working via plain name matching like before.
function findExerciseById(id) {
  return exerciseLibrary.find(e => e.id === id) || null;
}

function findExerciseByName(name) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return null;
  return exerciseLibrary.find(e => e.name.trim().toLowerCase() === key) || null;
}

// What to actually display for a logged/routine exercise entry: the *current*
// library name if it's linked (so a rename propagates), else the name captured
// at the time it was logged.
function displayExerciseName(entry) {
  if (entry.exerciseId) {
    const lib = findExerciseById(entry.exerciseId);
    if (lib) return lib.name;
  }
  return entry.name;
}

function exerciseMatchKey(entry) {
  return entry.exerciseId ? 'id:' + entry.exerciseId : 'name:' + entry.name.trim().toLowerCase();
}

// Resolve a typed/selected exercise name to the same key an already-linked entry
// would have, by checking whether it currently matches a library exercise.
function matchKeyForName(name) {
  const lib = findExerciseByName(name);
  return lib ? 'id:' + lib.id : 'name:' + (name || '').trim().toLowerCase();
}

function allExerciseNames(sessions) {
  const seen = new Map(); // matchKey -> display name (resolved live for linked entries)
  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date));
  sorted.forEach(s => {
    s.exercises.forEach(ex => {
      const display = displayExerciseName(ex).trim();
      if (display) seen.set(exerciseMatchKey(ex), display);
    });
  });
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// Autocomplete should offer both exercises saved in the library and any exercise
// names that only exist in past logged sessions (library entries take precedence
// for display casing since that's now the canonical source).
function knownExerciseNames() {
  const seen = new Map();
  exerciseLibrary.forEach(e => {
    const trimmed = (e.name || '').trim();
    if (trimmed) seen.set(trimmed.toLowerCase(), trimmed);
  });
  allExerciseNames(sessions).forEach(n => {
    const key = n.toLowerCase();
    if (!seen.has(key)) seen.set(key, n);
  });
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// Resolves every given exercise name to a library exerciseId, prompting once (a
// single dialog covering everything new) to add any that aren't in the library yet.
// Returns a Map of lowercase-name -> exerciseId for every name that ended up linked
// (pre-existing matches AND newly-created ones), so callers can stamp exerciseId
// onto the records they're about to save.
function promptAddNewExercises(names) {
  const linked = new Map();
  const newOnes = [];
  const seenThisCall = new Set();

  (names || []).forEach(n => {
    const trimmed = (n || '').trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    const existing = findExerciseByName(trimmed);
    if (existing) {
      linked.set(key, existing.id);
    } else if (!seenThisCall.has(key)) {
      newOnes.push(trimmed);
      seenThisCall.add(key);
    }
  });

  if (newOnes.length > 0) {
    const msg = newOnes.length === 1
      ? `Add "${newOnes[0]}" to your exercise library for future autocomplete?`
      : `Add these new exercises to your library for future autocomplete?\n\n${newOnes.map(n => '• ' + n).join('\n')}`;

    if (confirm(msg)) {
      newOnes.forEach(n => {
        const entry = { id: uid(), name: n };
        exerciseLibrary.push(entry);
        linked.set(n.toLowerCase(), entry.id);
      });
      saveExerciseLibrary(exerciseLibrary);
      refreshExerciseDatalist();
    }
  }

  return linked;
}

function fmtNum(n) {
  return Math.round(n).toLocaleString();
}

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateShort(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDuration(totalSeconds) {
  const total = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/* Most recent past session containing this exercise (matched by library ID when
   linked, so renaming an exercise doesn't disconnect it from its own history;
   falls back to a case-insensitive name match for never-linked exercises). */
function lastPerformanceFor(name) {
  if (!(name || '').trim()) return null;
  const targetKey = matchKeyForName(name);
  const matches = sessions
    .filter(s => s.exercises.some(ex => exerciseMatchKey(ex) === targetKey))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  if (matches.length === 0) return null;
  const session = matches[0];
  const ex = session.exercises.find(e => exerciseMatchKey(e) === targetKey);
  return { date: session.date, sets: ex.sets, volume: exerciseVolume(ex), notes: (ex.notes || '').trim() };
}

// True when the exercise's logged weight is "assistance" rather than load, so
// lower is better. Resolved through the library, so it follows renames.
function isInvertedExerciseName(name) {
  const entry = findExerciseByName(name);
  return !!(entry && entry.inverted);
}

/* ---------- Body weight helpers ---------- */
function sortedBodyWeights() {
  return [...bodyWeights].sort((a, b) => a.date.localeCompare(b.date));
}

function bodyWeightFor(date) {
  const hit = bodyWeights.find(w => w.date === date);
  return hit ? hit.weight : null;
}

// One entry per date: logging a date that already exists updates it in place and
// keeps the original id, so a re-sync updates the same spreadsheet row.
function upsertBodyWeight(date, weight) {
  const existing = bodyWeights.find(w => w.date === date);
  if (existing) {
    existing.weight = weight;
    existing.loggedAt = new Date().toISOString();
  } else {
    bodyWeights.push({ id: uid(), date, weight, loggedAt: new Date().toISOString() });
  }
  saveBodyWeights(bodyWeights);
  return existing ? 'updated' : 'added';
}

// Rolling average over the last `days` calendar days that actually have entries.
// Daily weight swings 2-4 lb on water alone; the average is the only readable signal.
function bodyWeightAverage(days = 7, endDate = todayStr()) {
  const end = new Date(endDate + 'T00:00:00');
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  const startStr = start.toISOString().slice(0, 10);
  const inWindow = bodyWeights.filter(w => w.date >= startStr && w.date <= endDate);
  if (inWindow.length === 0) return null;
  const sum = inWindow.reduce((acc, w) => acc + (Number(w.weight) || 0), 0);
  return { avg: sum / inWindow.length, count: inWindow.length };
}

/* ---------- App state ---------- */
let sessions = loadSessions();
let routines = loadRoutines().map(normalizeRoutine);
let exerciseLibrary = normalizeExerciseLibrary(loadExerciseLibrary());
let bodyWeights = loadBodyWeights();
let syncConfig = loadSyncConfig();
let editingSessionId = null;
let currentView = 'log';
let openSessionIds = new Set();
let draftRoutine = null; // { id: string|null, name: string, exercises: [{name, sets}] }
let activeWorkout = null; // { startTime: epochMs, date, routineId, routineName } while a workout is in progress
let timerInterval = null;

/* Keep the fixed End Workout button positioned correctly above the bottom tab bar. */
function syncLayoutVars() {
  const tabbarEl = document.querySelector('nav.tabbar');
  if (tabbarEl) document.documentElement.style.setProperty('--tabbar-h', tabbarEl.offsetHeight + 'px');
}
window.addEventListener('resize', syncLayoutVars);
window.addEventListener('load', syncLayoutVars);

/* ---------- Tab navigation ---------- */
const views = {
  log: document.getElementById('view-log'),
  routines: document.getElementById('view-routines'),
  exercises: document.getElementById('view-exercises'),
  history: document.getElementById('view-history'),
  charts: document.getElementById('view-charts'),
};
const tabBtns = document.querySelectorAll('.tab-btn');
const headerEl = document.querySelector('header');
const headerTitle = document.getElementById('headerTitle');
const headerSubtitle = document.getElementById('headerSubtitle');

const titles = {
  log: ['Workout', "Log today's session"],
  routines: ['Routines', 'Build & manage your routines'],
  exercises: ['Exercises', 'Your exercise library'],
  history: ['History', 'Past workout sessions'],
  charts: ['Progress', 'Body weight and strength trends'],
};

function setView(name) {
  currentView = name;
  hideAutocomplete();
  Object.entries(views).forEach(([k, el]) => el.classList.toggle('active', k === name));
  tabBtns.forEach(b => b.classList.toggle('active', b.dataset.view === name));
  headerTitle.textContent = titles[name][0];
  headerSubtitle.textContent = titles[name][1];
  if (name !== 'log') headerEl.style.display = '';
  if (name === 'history') renderHistory();
  if (name === 'charts') renderCharts();
  if (name === 'routines') renderRoutineList();
  if (name === 'exercises') renderExerciseLibrary();
  if (name === 'log') {
    renderExerciseList();
    if (activeWorkout) showWorkoutScreen(); else showPreWorkoutScreen();
  }
}

tabBtns.forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));

/* ---------- Toast ---------- */
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ---------- LOG VIEW ---------- */
const sessionDateInput = document.getElementById('sessionDate');
const exerciseListEl = document.getElementById('exerciseList');
const exerciseNamesDatalist = document.getElementById('exerciseNames');

sessionDateInput.value = todayStr();

/* ---------- Daily weigh-in ---------- */
const bwDateInput = document.getElementById('bwDate');
const bwWeightInput = document.getElementById('bwWeight');
const bwStatsEl = document.getElementById('bwStats');

bwDateInput.value = todayStr();

function renderBodyWeightCard() {
  const date = bwDateInput.value || todayStr();
  const existing = bodyWeightFor(date);
  if (document.activeElement !== bwWeightInput) {
    bwWeightInput.value = existing == null ? '' : existing;
  }

  const avg7 = bodyWeightAverage(7);
  const all = sortedBodyWeights();
  const recent = all.slice(-5).reverse();

  if (all.length === 0) {
    bwStatsEl.innerHTML = 'No weigh-ins yet. The daily number is noise — the 7-day average is the signal, so log it most mornings and ignore any single reading.';
    return;
  }

  const first = all[0];
  const latest = all[all.length - 1];
  const change = latest.weight - first.weight;
  const changeStr = `${change >= 0 ? '+' : ''}${(Math.round(change * 10) / 10).toFixed(1)}`;

  bwStatsEl.innerHTML = `
    ${avg7 ? `7-day avg <span class="bw-avg">${(Math.round(avg7.avg * 10) / 10).toFixed(1)} lb</span> <span style="opacity:.7;">(${avg7.count} of 7 days)</span><br>` : ''}
    Since ${fmtDateShort(first.date)}: ${escapeHtml(changeStr)} lb over ${all.length} weigh-in${all.length !== 1 ? 's' : ''}
    <div class="bw-recent">
      ${recent.map(w => `<span class="bw-chip${w.date === todayStr() ? ' today' : ''}">${fmtDateShort(w.date)} · ${w.weight}</span>`).join('')}
    </div>
  `;
}

bwDateInput.addEventListener('change', renderBodyWeightCard);

document.getElementById('bwSaveBtn').addEventListener('click', () => {
  const date = bwDateInput.value || todayStr();
  const raw = bwWeightInput.value;
  const weight = Number(raw);
  if (raw === '' || isNaN(weight) || weight <= 0) {
    showToast('Enter a weight first');
    return;
  }
  const action = upsertBodyWeight(date, weight);
  renderBodyWeightCard();
  if (currentView === 'charts') renderCharts();
  showToast(action === 'updated' ? 'Weigh-in updated ✓' : 'Weigh-in logged ✓');
  scheduleSync();
});

function refreshExerciseDatalist() {
  exerciseNamesDatalist.innerHTML = knownExerciseNames()
    .map(n => `<option value="${escapeHtml(n)}">`).join('');
}

/* ---------- Exercise name autocomplete ----------
   Native <datalist>/list="" suggestions are unreliable on iOS Safari (long-standing
   rendering bugs, and a fresh regression in iOS 26), which is why typing an exercise
   name on the Workout/Routines tabs wasn't showing suggestions. This drives its own
   lightweight dropdown instead, via event delegation so it keeps working across
   re-renders. The list="exerciseNames" attribute stays in the markup too — harmless,
   and still gives desktop browsers a native fallback. */
const autocompleteBox = document.getElementById('autocompleteBox');
const AUTOCOMPLETE_SELECTOR = '[data-role="ex-name"], [data-role="rex-name"]';
let acInput = null;

function hideAutocomplete() {
  autocompleteBox.style.display = 'none';
  autocompleteBox.innerHTML = '';
  acInput = null;
}

function showAutocompleteFor(input) {
  const q = input.value.trim().toLowerCase();
  if (!q) { hideAutocomplete(); return; }

  const matches = knownExerciseNames()
    .filter(n => n.toLowerCase().includes(q))
    .sort((a, b) => {
      const aStarts = a.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.toLowerCase().startsWith(q) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.localeCompare(b);
    })
    .slice(0, 8);

  if (matches.length === 0 || (matches.length === 1 && matches[0].toLowerCase() === q)) {
    hideAutocomplete();
    return;
  }

  acInput = input;
  autocompleteBox.innerHTML = matches.map(n => `<div class="ac-item">${escapeHtml(n)}</div>`).join('');

  const rect = input.getBoundingClientRect();
  autocompleteBox.style.left = rect.left + 'px';
  autocompleteBox.style.top = (rect.bottom + 4) + 'px';
  autocompleteBox.style.width = rect.width + 'px';
  autocompleteBox.style.display = 'block';
}

document.addEventListener('input', (e) => {
  if (e.target.matches && e.target.matches(AUTOCOMPLETE_SELECTOR)) showAutocompleteFor(e.target);
});

document.addEventListener('focusin', (e) => {
  if (e.target.matches && e.target.matches(AUTOCOMPLETE_SELECTOR)) showAutocompleteFor(e.target);
});

document.addEventListener('focusout', (e) => {
  if (e.target.matches && e.target.matches(AUTOCOMPLETE_SELECTOR)) {
    // Short delay so a tap on a suggestion (handled on mousedown, below) can still
    // register before the box gets torn down.
    setTimeout(() => { if (acInput === e.target) hideAutocomplete(); }, 150);
  }
});

// mousedown fires before blur; preventDefault keeps the field focused so picking a
// suggestion doesn't flicker the on-screen keyboard closed on mobile.
autocompleteBox.addEventListener('mousedown', (e) => {
  const item = e.target.closest('.ac-item');
  if (!item || !acInput) return;
  e.preventDefault();
  const input = acInput;
  input.value = item.textContent;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  hideAutocomplete();
});

window.addEventListener('scroll', hideAutocomplete, true);
window.addEventListener('resize', hideAutocomplete);

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

let draftExercises = []; // [{ id, name, sets: [{weight, reps}], notes }]

// While editing, minutes and seconds are two separate fields (mm / ss); they're
// folded into a single whole-second count on save.
function newCardioBout() {
  return { mm: '', ss: '', distanceMi: '', inclinePct: '' };
}

// Split a stored bout back into the two edit fields.
function boutToFields(bout) {
  const total = boutSeconds(bout);
  if (!total) {
    return {
      mm: bout && bout.mm !== undefined ? bout.mm : '',
      ss: bout && bout.ss !== undefined ? bout.ss : '',
    };
  }
  return { mm: String(Math.floor(total / 60)), ss: String(total % 60).padStart(2, '0') };
}

// mm/ss as typed -> total seconds. Seconds over 59 roll up rather than being
// rejected, so typing "90" in the seconds box gives you 1:30 instead of an error.
function fieldsToSeconds(bout) {
  const mm = Number(bout.mm) || 0;
  const ss = Number(bout.ss) || 0;
  return Math.max(0, Math.round(mm * 60 + ss));
}

function newDraftExercise(name = '') {
  const cardio = isCardioExerciseName(name);
  return {
    id: uid(),
    name,
    kind: cardio ? 'cardio' : 'strength',
    sets: [cardio ? newCardioBout() : { weight: '', reps: '' }],
    notes: '',
  };
}

/* Weight x reps rows — the original layout. */
function buildStrengthRows(block, ex, perf) {
  const setsHeader = document.createElement('div');
  setsHeader.className = 'sets-header';
  setsHeader.innerHTML = `
    <span class="set-idx">SET</span>
    <span class="col-prev" data-role="prev-header">${perf ? `PREV (${fmtDateShort(perf.date)})` : 'PREV'}</span>
    <span class="col-weight">WEIGHT</span>
    <span class="col-reps">REPS</span>
    <span class="col-remove"></span>
  `;
  block.appendChild(setsHeader);

  const setsWrap = document.createElement('div');
  setsWrap.className = 'sets-wrap';
  ex.sets.forEach((set, si) => {
    const row = document.createElement('div');
    row.className = 'set-row';
    const prevSet = perf && perf.sets[si];
    const prevText = prevSet ? `${prevSet.weight}×${prevSet.reps}` : '—';
    row.innerHTML = `
      <span class="set-idx">${si + 1}</span>
      <span class="prev-val" data-role="prev-val">${prevText}</span>
      <input type="number" inputmode="decimal" placeholder="Weight" min="0" step="any" value="${set.weight}" data-role="weight">
      <input type="number" inputmode="numeric" placeholder="Reps" min="0" step="1" value="${set.reps}" data-role="reps">
      <button class="remove-set" data-role="remove-set" title="Remove set">–</button>
    `;
    row.querySelector('[data-role="weight"]').addEventListener('input', (e) => set.weight = e.target.value);
    row.querySelector('[data-role="reps"]').addEventListener('input', (e) => set.reps = e.target.value);
    row.querySelector('[data-role="remove-set"]').addEventListener('click', () => {
      ex.sets = ex.sets.filter((_, i) => i !== si);
      if (ex.sets.length === 0) ex.sets.push({ weight: '', reps: '' });
      renderExerciseList();
    });
    setsWrap.appendChild(row);
  });
  block.appendChild(setsWrap);

  const addSetBtn = document.createElement('button');
  addSetBtn.className = 'add-set-btn';
  addSetBtn.textContent = '+ Add Set';
  addSetBtn.addEventListener('click', () => {
    ex.sets.push({ weight: '', reps: '' });
    renderExerciseList();
  });
  block.appendChild(addSetBtn);
}

/* Time / distance / incline rows. Speed and pace are shown live under the inputs
   rather than being fields of their own — one less thing to type on a treadmill,
   and they can never disagree with the numbers they're derived from. */
function buildCardioRows(block, ex, perf) {
  // Cardio has no per-set PREV column, so last time's numbers go on one line.
  const prevLine = document.createElement('div');
  prevLine.className = 'cardio-prev';
  prevLine.dataset.role = 'cardio-prev';
  block.appendChild(prevLine);
  paintCardioPrev(block, perf);

  const header = document.createElement('div');
  header.className = 'sets-header cardio-header';
  header.innerHTML = `
    <span class="set-idx">#</span>
    <span class="col-min">MIN</span>
    <span class="col-sec">SEC</span>
    <span class="col-dist">DIST (MI)</span>
    <span class="col-incline">INCL %</span>
    <span class="col-remove"></span>
  `;
  block.appendChild(header);

  const wrap = document.createElement('div');
  wrap.className = 'sets-wrap';

  const repaintDerived = () => {
    const el = block.querySelector('[data-role="cardio-derived"]');
    if (!el) return;
    const secs = ex.sets.reduce((sum, b) => sum + fieldsToSeconds(b), 0);
    const dist = cardioDistance(ex.sets);
    if (!secs) { el.textContent = ''; return; }
    const parts = [formatDuration(secs)];
    if (dist > 0) {
      const mph = dist / (secs / 3600);
      parts.push(`${(Math.round(mph * 10) / 10).toFixed(1)} mph`);
      parts.push(`${fmtPace((secs / 60) / dist)}/mi`);
    }
    el.textContent = parts.join('  ·  ');
  };

  ex.sets.forEach((bout, si) => {
    // Seed the two edit fields from whatever shape the bout is currently in.
    const f = boutToFields(bout);
    if (bout.mm === undefined) bout.mm = f.mm;
    if (bout.ss === undefined) bout.ss = f.ss;

    const row = document.createElement('div');
    row.className = 'set-row cardio-row';
    row.innerHTML = `
      <span class="set-idx">${si + 1}</span>
      <input type="number" inputmode="numeric" placeholder="12" min="0" step="1" value="${bout.mm ?? ''}" data-role="c-min">
      <input type="number" inputmode="numeric" placeholder="00" min="0" step="1" value="${bout.ss ?? ''}" data-role="c-sec">
      <input type="number" inputmode="decimal" placeholder="mi" min="0" step="any" value="${bout.distanceMi ?? ''}" data-role="c-dist">
      <input type="number" inputmode="decimal" placeholder="%" min="0" step="any" value="${bout.inclinePct ?? ''}" data-role="c-incline">
      <button class="remove-set" data-role="remove-set" title="Remove">–</button>
    `;
    row.querySelector('[data-role="c-min"]').addEventListener('input', (e) => { bout.mm = e.target.value; repaintDerived(); });
    row.querySelector('[data-role="c-sec"]').addEventListener('input', (e) => { bout.ss = e.target.value; repaintDerived(); });
    row.querySelector('[data-role="c-dist"]').addEventListener('input', (e) => { bout.distanceMi = e.target.value; repaintDerived(); });
    row.querySelector('[data-role="c-incline"]').addEventListener('input', (e) => { bout.inclinePct = e.target.value; });
    row.querySelector('[data-role="remove-set"]').addEventListener('click', () => {
      ex.sets = ex.sets.filter((_, i) => i !== si);
      if (ex.sets.length === 0) ex.sets.push(newCardioBout());
      renderExerciseList();
    });
    wrap.appendChild(row);
  });
  block.appendChild(wrap);

  const derived = document.createElement('div');
  derived.className = 'cardio-derived';
  derived.dataset.role = 'cardio-derived';
  block.appendChild(derived);

  const addBtn = document.createElement('button');
  addBtn.className = 'add-set-btn';
  addBtn.textContent = '+ Add Interval';
  addBtn.addEventListener('click', () => {
    ex.sets.push(newCardioBout());
    renderExerciseList();
  });
  block.appendChild(addBtn);

  repaintDerived();
}

// Show/hide + fill the "note from last time" banner for one exercise block.
// Reads from the same past session the PREV column is showing, so everything on
// the card refers to one consistent previous workout.
function updateBlockPrevNote(block, perf) {
  const noteEl = block.querySelector('[data-role="prev-note"]');
  if (!noteEl) return;
  const note = perf && perf.notes ? perf.notes : '';
  if (!note) {
    noteEl.hidden = true;
    return;
  }
  noteEl.hidden = false;
  const dateEl = noteEl.querySelector('[data-role="prev-note-date"]');
  const textEl = noteEl.querySelector('[data-role="prev-note-text"]');
  if (dateEl) dateEl.textContent = fmtDateShort(perf.date);
  if (textEl) textEl.textContent = note;
}

// Refresh the "PREV" header + per-set previous values for one exercise block
// without rebuilding the DOM (keeps focus/cursor position while typing the name).
function paintCardioPrev(block, perf) {
  const el = block.querySelector('[data-role="cardio-prev"]');
  if (!el) return;
  const summary = perf ? cardioSummary(perf.sets) : '';
  if (!summary) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span class="cardio-prev-date">PREV ${escapeHtml(fmtDateShort(perf.date))}</span> ${escapeHtml(summary)}`;
}

function updateBlockPrevData(block, ex) {
  const perf = lastPerformanceFor(ex.name);
  const headerPrevEl = block.querySelector('[data-role="prev-header"]');
  if (headerPrevEl) headerPrevEl.textContent = perf ? `PREV (${fmtDateShort(perf.date)})` : 'PREV';
  block.querySelectorAll('[data-role="prev-val"]').forEach((el, si) => {
    const s = perf && perf.sets[si];
    el.textContent = s ? `${s.weight}×${s.reps}` : '—';
  });
  paintCardioPrev(block, perf);
  updateBlockPrevNote(block, perf);
}

function renderExerciseList() {
  exerciseListEl.innerHTML = '';
  draftExercises.forEach((ex) => {
    const block = document.createElement('div');
    block.className = 'exercise-block';

    const head = document.createElement('div');
    head.className = 'exercise-block-head';
    head.innerHTML = `
      <input type="text" placeholder="Exercise name (e.g. Bench Press)" list="exerciseNames"
        value="${escapeHtml(ex.name)}" data-role="ex-name">
      <button class="remove-x" data-role="remove-ex" title="Remove exercise">✕</button>
    `;
    block.appendChild(head);

    const perf = lastPerformanceFor(ex.name);

    // Note from the last time this exercise was performed. Sits between the
    // exercise name and the set-table column headers; hidden when there is none.
    const prevNote = document.createElement('div');
    prevNote.className = 'prev-note';
    prevNote.dataset.role = 'prev-note';
    prevNote.innerHTML = `
      <span class="prev-note-date" data-role="prev-note-date"></span>
      <span class="prev-note-text" data-role="prev-note-text"></span>
    `;
    block.appendChild(prevNote);
    updateBlockPrevNote(block, perf);

    const isCardio = exerciseIsCardio({ name: ex.name, kind: ex.kind });
    block.dataset.kind = isCardio ? 'cardio' : 'strength';

    if (isCardio) buildCardioRows(block, ex, perf);
    else buildStrengthRows(block, ex, perf);

    const notesWrap = document.createElement('div');
    notesWrap.className = 'notes-row';
    notesWrap.innerHTML = `<input type="text" placeholder="Notes (optional)" value="${escapeHtml(ex.notes || '')}" data-role="notes">`;
    notesWrap.querySelector('[data-role="notes"]').addEventListener('input', (e) => { ex.notes = e.target.value; });
    block.appendChild(notesWrap);

    head.querySelector('[data-role="ex-name"]').addEventListener('input', (e) => {
      ex.name = e.target.value;
      // Typing the name of a cardio exercise has to swap the whole row layout —
      // weight/reps and time/distance are different fields. Only rebuild on an
      // actual kind change, and put the cursor back where it was afterwards.
      const nowKind = isCardioExerciseName(ex.name) ? 'cardio' : 'strength';
      if (nowKind !== block.dataset.kind) {
        ex.kind = nowKind;
        ex.sets = [nowKind === 'cardio' ? newCardioBout() : { weight: '', reps: '' }];
        const caret = e.target.selectionStart;
        renderExerciseList();
        const again = [...exerciseListEl.querySelectorAll('[data-role="ex-name"]')]
          .find(inp => inp.value === ex.name);
        if (again) {
          again.focus();
          try { again.setSelectionRange(caret, caret); } catch (err) { /* not all inputs support it */ }
        }
        return;
      }
      updateBlockPrevData(block, ex);
    });
    head.querySelector('[data-role="remove-ex"]').addEventListener('click', () => {
      draftExercises = draftExercises.filter(d => d.id !== ex.id);
      renderExerciseList();
    });

    exerciseListEl.appendChild(block);
  });
}

document.getElementById('addExerciseBtn').addEventListener('click', () => {
  draftExercises.push(newDraftExercise());
  renderExerciseList();
});

/* ---------- Routine picker on Pre-Workout Screen ---------- */
const routineSelect = document.getElementById('routineSelect');

function populateRoutineSelect() {
  const current = routineSelect.value;
  routineSelect.innerHTML = '<option value="">— None / Freestyle —</option>' +
    routines.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
  if (routines.some(r => r.id === current)) routineSelect.value = current;
}

/* ---------- Pre-Workout Screen <-> Workout Screen ---------- */
const preWorkoutScreenEl = document.getElementById('preWorkoutScreen');
const workoutScreenEl = document.getElementById('workoutScreen');
const endWorkoutBtn = document.getElementById('endWorkoutBtn');
const activeRoutineNameEl = document.getElementById('activeRoutineName');
const activeWorkoutDateEl = document.getElementById('activeWorkoutDate');
const workoutTimerEl = document.getElementById('workoutTimer');

function showPreWorkoutScreen() {
  preWorkoutScreenEl.style.display = 'block';
  workoutScreenEl.style.display = 'none';
  endWorkoutBtn.style.display = 'none';
  headerEl.style.display = '';
}

// iOS often "resumes" a standalone home-screen app from a frozen/suspended state
// instead of re-running app.js from scratch, so the date field can be left showing
// whatever it had when the app was last backgrounded. pageshow fires on every resume
// (including bfcache restores), so re-stamp today's date whenever we're sitting on
// the Pre-Workout Screen with no workout in progress.
window.addEventListener('pageshow', () => {
  if (!activeWorkout && preWorkoutScreenEl.style.display !== 'none') {
    sessionDateInput.value = todayStr();
  }
});

function showWorkoutScreen() {
  preWorkoutScreenEl.style.display = 'none';
  workoutScreenEl.style.display = 'block';
  endWorkoutBtn.style.display = 'flex';
  headerEl.style.display = 'none'; // sticky routine/date/timer bar replaces it while a workout is active
  activeRoutineNameEl.textContent = activeWorkout.routineName || 'Freestyle Workout';
  activeWorkoutDateEl.textContent = fmtDate(activeWorkout.date);
  syncLayoutVars();
  updateTimerDisplay();
}

function updateTimerDisplay() {
  if (!activeWorkout) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - activeWorkout.startTime) / 1000));
  workoutTimerEl.textContent = formatDuration(elapsed);
}

function startTimerInterval() {
  stopTimerInterval();
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    updateTimerDisplay();
    // periodic autosave so a locked/backgrounded/reloaded phone doesn't lose progress
    if (activeWorkout) saveActiveWorkout(activeWorkout, draftExercises);
  }, 1000);
}

function stopTimerInterval() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

document.getElementById('startWorkoutBtn').addEventListener('click', () => {
  const routineId = routineSelect.value;
  const routine = routineId ? routines.find(r => r.id === routineId) : null;
  const date = sessionDateInput.value || todayStr();

  draftExercises = routine
    ? routine.exercises.map(re => {
        const de = newDraftExercise(re.name);
        // A routine's "sets" count is a strength idea; cardio gets a single bout
        // unless you add intervals during the workout.
        if (de.kind === 'cardio') return de;
        const count = Math.max(1, Number(re.sets) || 1);
        de.sets = Array.from({ length: count }, () => ({ weight: '', reps: '' }));
        return de;
      })
    : [newDraftExercise()];

  activeWorkout = {
    startTime: Date.now(),
    date,
    routineId: routine ? routine.id : null,
    routineName: routine ? routine.name : null,
  };
  saveActiveWorkout(activeWorkout, draftExercises);

  renderExerciseList();
  showWorkoutScreen();
  startTimerInterval();
});

/* ---------- SAVE GUARD ----------
   Everything the save path used to throw away in silence. A set with a weight and
   no reps, or an exercise sitting in the routine that never got a number typed
   into it, simply vanished on End Workout — which is how three weeks of squats
   went missing without a single warning. Discarding is still allowed; it just has
   to be a decision now. */

// Cardio bouts only need a duration to be worth keeping — distance and incline
// are optional, since not every machine reports them.
function normalizeExercise(ex) {
  const kind = exerciseIsCardio({ name: ex.name, kind: ex.kind }) ? 'cardio' : 'strength';
  const sets = kind === 'cardio'
    ? (ex.sets || [])
        .map(s => ({
          seconds: fieldsToSeconds(s),
          distanceMi: s.distanceMi === '' || s.distanceMi == null ? 0 : Number(s.distanceMi) || 0,
          inclinePct: s.inclinePct === '' || s.inclinePct == null ? 0 : Number(s.inclinePct) || 0,
        }))
        .filter(s => s.seconds > 0)
    : (ex.sets || [])
        .filter(s => s.weight !== '' && s.reps !== '' && !isNaN(Number(s.weight)) && !isNaN(Number(s.reps)))
        .map(s => ({ weight: Number(s.weight), reps: Number(s.reps) }));
  return { name: (ex.name || '').trim(), kind, notes: (ex.notes || '').trim(), sets };
}

const blank = (v) => String(v == null ? '' : v).trim() === '';

function describeStrengthRow(s) {
  const w = blank(s.weight) ? 'weight blank' : `${String(s.weight).trim()} lb`;
  const r = blank(s.reps) ? 'reps blank' : `${String(s.reps).trim()} reps`;
  return `${w}, ${r}`;
}

function describeCardioRow(s) {
  const bits = [];
  const f = boutToFields(s);
  bits.push(blank(f.mm) && blank(f.ss) ? 'no time' : `${blank(f.mm) ? 0 : f.mm}:${String(blank(f.ss) ? 0 : f.ss).padStart(2, '0')}`);
  if (!blank(s.distanceMi)) bits.push(`${String(s.distanceMi).trim()} mi`);
  if (!blank(s.inclinePct)) bits.push(`${String(s.inclinePct).trim()}% incline`);
  return bits.join(', ');
}

/* Splits a draft into what will actually be written and what would be lost.
   A wholly blank set row is not a loss — the app always keeps a trailing empty
   row — so only rows with something typed in them get flagged. */
function auditDraftExercises(drafts) {
  const exercises = [];
  const issues = [];
  // Index in `drafts` of each kept exercise, so a caller that needs to merge
  // fields back onto the original (the history editor keeps exerciseId) can
  // line them up even when entries in between were dropped.
  const keptIndexes = [];

  (drafts || []).forEach((ex, exIdx) => {
    const clean = normalizeExercise(ex);
    const cardio = clean.kind === 'cardio';
    const rows = [];

    (ex.sets || []).forEach((s, i) => {
      if (cardio) {
        if (fieldsToSeconds(s) > 0) return;
        const f = boutToFields(s);
        if (!blank(f.mm) || !blank(f.ss) || !blank(s.distanceMi) || !blank(s.inclinePct)) {
          rows.push({ index: i + 1, detail: describeCardioRow(s) });
        }
      } else {
        const usable = !blank(s.weight) && !blank(s.reps) && !isNaN(Number(s.weight)) && !isNaN(Number(s.reps));
        if (usable) return;
        if (!blank(s.weight) || !blank(s.reps)) rows.push({ index: i + 1, detail: describeStrengthRow(s) });
      }
    });

    if (!clean.name) {
      // An unnamed row with data typed into it can't be saved at all.
      if (clean.sets.length || rows.length) {
        issues.push({ name: 'Unnamed exercise', type: 'unnamed', rows, keptSets: clean.sets.length });
      }
      return;
    }

    if (clean.sets.length === 0) {
      issues.push({ name: displayExerciseName(clean), type: rows.length ? 'partial-only' : 'empty', rows });
      return;
    }

    if (rows.length) issues.push({ name: displayExerciseName(clean), type: 'partial', rows });
    exercises.push(clean);
    keptIndexes.push(exIdx);
  });

  return { exercises, issues, keptIndexes };
}

function guardIssueHtml(issue) {
  let why;
  if (issue.type === 'empty') why = 'nothing logged — will not be saved';
  else if (issue.type === 'unnamed') why = 'no exercise name — cannot be saved';
  else if (issue.type === 'partial-only') why = `no complete sets — will not be saved`;
  else why = `${issue.rows.length} incomplete set${issue.rows.length !== 1 ? 's' : ''} will be dropped`;
  const rows = issue.rows.length
    ? `<div class="guard-rows">${issue.rows.map(r => `<div>Set ${r.index}: ${escapeHtml(r.detail)}</div>`).join('')}</div>`
    : '';
  return `
    <div class="guard-item${issue.type === 'empty' ? ' soft' : ''}" data-issue="${issue.type}">
      <div class="guard-name">${escapeHtml(issue.name)}</div>
      <div class="guard-why">${escapeHtml(why)}</div>
      ${rows}
    </div>`;
}

function closeSaveGuard() {
  const el = document.getElementById('saveGuard');
  if (el) el.remove();
}

/* Fix is the primary action. Discarding is possible but deliberate. */
function showSaveGuard(issues, { onFix, onDiscard, discardLabel } = {}) {
  closeSaveGuard();
  const wrap = document.createElement('div');
  wrap.id = 'saveGuard';
  wrap.className = 'guard-backdrop';
  wrap.innerHTML = `
    <div class="guard-sheet" role="dialog" aria-modal="true" aria-labelledby="guardTitle">
      <div class="guard-title" id="guardTitle">Some of this won't be saved</div>
      <div class="guard-list">${issues.map(guardIssueHtml).join('')}</div>
      <div class="guard-actions">
        <button class="btn btn-primary" data-role="guard-fix">Go Back &amp; Fix</button>
        <button class="btn btn-secondary btn-sm" data-role="guard-discard">${escapeHtml(discardLabel || 'Save Without Them')}</button>
      </div>
    </div>`;
  wrap.querySelector('[data-role="guard-fix"]').addEventListener('click', () => {
    closeSaveGuard();
    if (onFix) onFix();
  });
  wrap.querySelector('[data-role="guard-discard"]').addEventListener('click', () => {
    closeSaveGuard();
    if (onDiscard) onDiscard();
  });
  // Tapping the backdrop is the same as backing out — the safe direction.
  wrap.addEventListener('click', (e) => {
    if (e.target !== wrap) return;
    closeSaveGuard();
    if (onFix) onFix();
  });
  document.body.appendChild(wrap);
  return wrap;
}

endWorkoutBtn.addEventListener('click', () => {
  if (!activeWorkout) return;

  const { exercises: cleanExercises, issues } = auditDraftExercises(draftExercises);
  if (issues.length > 0) {
    // Don't stop the clock yet — going back to fix things has to leave the
    // workout exactly as it was.
    showSaveGuard(issues, {
      onFix: () => { renderExerciseList(); },
      onDiscard: () => finishWorkout(cleanExercises),
    });
    return;
  }
  finishWorkout(cleanExercises);
});

function finishWorkout(cleanExercises) {
  if (!activeWorkout) return;
  const durationSeconds = Math.max(0, Math.floor((Date.now() - activeWorkout.startTime) / 1000));
  stopTimerInterval();

  if (cleanExercises.length > 0) {
    const linked = promptAddNewExercises(cleanExercises.map(ex => ex.name));
    cleanExercises.forEach(ex => {
      ex.exerciseId = linked.get(ex.name.toLowerCase()) || null;
    });

    sessions.push({
      id: uid(),
      date: activeWorkout.date,
      exercises: cleanExercises,
      durationSeconds,
      routineId: activeWorkout.routineId || null,
      routineName: activeWorkout.routineName || null,
      startedAt: new Date(activeWorkout.startTime).toISOString(),
      endedAt: new Date().toISOString(),
    });
    saveSessions(sessions);
    refreshExerciseDatalist();
    showToast(`Workout saved ✓ (${formatDuration(durationSeconds)})`);
    scheduleSync();
  } else {
    showToast('Workout ended — no sets logged, nothing saved');
  }

  activeWorkout = null;
  clearActiveWorkoutStorage();
  draftExercises = [newDraftExercise()];
  renderExerciseList();
  // Safe moment to pick up an update that arrived mid-workout.
  applyUpdateIfDeferred();
  sessionDateInput.value = todayStr();
  routineSelect.value = '';
  showPreWorkoutScreen();
}

/* ---------- ROUTINES VIEW ---------- */
const routineListEl = document.getElementById('routineList');
const routineEditorEl = document.getElementById('routineEditor');
const routineNameInput = document.getElementById('routineNameInput');
const routineExerciseListEl = document.getElementById('routineExerciseList');

function renderRoutineList() {
  if (routines.length === 0) {
    routineListEl.innerHTML = `
      <div class="empty-state">
        <div class="big">📋</div>
        No routines yet.<br>Create one to quickly load your usual exercises on the Log tab.
      </div>`;
    return;
  }

  routineListEl.innerHTML = '';
  routines.forEach(r => {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.innerHTML = `
      <div class="session-head" style="cursor:default;">
        <div>
          <div class="date">${escapeHtml(r.name)}</div>
          <div class="meta">${r.exercises.length} exercise${r.exercises.length !== 1 ? 's' : ''}</div>
        </div>
      </div>
      <div class="session-body open">
        <div class="ex-row"><div class="sets">${r.exercises.map(e => `${escapeHtml(displayExerciseName(e))} (${e.sets})`).join(' · ')}</div></div>
        <div class="session-actions" style="justify-content:space-between;">
          <button class="btn btn-secondary btn-sm" data-role="edit">Edit</button>
          <button class="btn btn-danger btn-sm" data-role="delete">Delete</button>
        </div>
      </div>
    `;
    card.querySelector('[data-role="edit"]').addEventListener('click', () => openRoutineEditor(r));
    card.querySelector('[data-role="delete"]').addEventListener('click', () => {
      if (confirm(`Delete routine "${r.name}"?`)) {
        routines = routines.filter(x => x.id !== r.id);
        saveRoutines(routines);
        renderRoutineList();
        populateRoutineSelect();
      }
    });
    routineListEl.appendChild(card);
  });
}

function openRoutineEditor(routine) {
  draftRoutine = routine
    ? { id: routine.id, name: routine.name, exercises: routine.exercises.map(e => ({ ...e })) }
    : { id: null, name: '', exercises: [{ name: '', sets: '', exerciseId: null }] };
  routineNameInput.value = draftRoutine.name;
  renderRoutineExerciseInputs();
  routineEditorEl.style.display = 'block';
  if (typeof routineEditorEl.scrollIntoView === 'function') {
    routineEditorEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function closeRoutineEditor() {
  routineEditorEl.style.display = 'none';
  draftRoutine = null;
}

function renderRoutineExerciseInputs() {
  routineExerciseListEl.innerHTML = '';
  draftRoutine.exercises.forEach((ex, i) => {
    const row = document.createElement('div');
    row.className = 'set-row';
    // Up/down buttons rather than drag-and-drop: dragging a list item on a phone
    // fights with page scrolling, and this only ever needs to move a few rows.
    const last = draftRoutine.exercises.length - 1;
    row.innerHTML = `
      <span class="set-idx">${i + 1}</span>
      <div class="reorder-btns">
        <button class="reorder-btn" data-role="move-up" title="Move up" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="reorder-btn" data-role="move-down" title="Move down" ${i === last ? 'disabled' : ''}>▼</button>
      </div>
      <input type="text" placeholder="Exercise name" list="exerciseNames" value="${escapeHtml(ex.name)}" data-role="rex-name">
      <input type="number" class="rex-sets" min="1" step="1" placeholder="Sets" value="${ex.sets}" data-role="rex-sets">
      <button class="remove-set" data-role="remove-rex" title="Remove">–</button>
    `;
    row.querySelector('[data-role="rex-name"]').addEventListener('input', (e) => {
      draftRoutine.exercises[i].name = e.target.value;
    });
    row.querySelector('[data-role="rex-sets"]').addEventListener('input', (e) => {
      draftRoutine.exercises[i].sets = e.target.value;
    });
    row.querySelector('[data-role="move-up"]').addEventListener('click', () => moveRoutineExercise(i, -1));
    row.querySelector('[data-role="move-down"]').addEventListener('click', () => moveRoutineExercise(i, 1));
    row.querySelector('[data-role="remove-rex"]').addEventListener('click', () => {
      draftRoutine.exercises.splice(i, 1);
      if (draftRoutine.exercises.length === 0) draftRoutine.exercises.push({ name: '', sets: '', exerciseId: null });
      renderRoutineExerciseInputs();
    });
    routineExerciseListEl.appendChild(row);
  });
}

/* Swap a routine exercise with its neighbour. Nothing is saved until you hit
   Save Routine, so this is as cancellable as any other edit in the editor. */
function moveRoutineExercise(index, delta) {
  const list = draftRoutine.exercises;
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
  renderRoutineExerciseInputs();
  // Keep the moved row's button under the finger so repeated taps keep moving it.
  const rows = routineExerciseListEl.querySelectorAll('.set-row');
  const btn = rows[target] && rows[target].querySelector(delta < 0 ? '[data-role="move-up"]' : '[data-role="move-down"]');
  if (btn && !btn.disabled && typeof btn.focus === 'function') btn.focus();
}

document.getElementById('newRoutineBtn').addEventListener('click', () => openRoutineEditor(null));

document.getElementById('addRoutineExerciseBtn').addEventListener('click', () => {
  draftRoutine.exercises.push({ name: '', sets: '', exerciseId: null });
  renderRoutineExerciseInputs();
});

routineNameInput.addEventListener('input', (e) => {
  if (draftRoutine) draftRoutine.name = e.target.value;
});

document.getElementById('cancelRoutineBtn').addEventListener('click', closeRoutineEditor);

document.getElementById('saveRoutineBtn').addEventListener('click', () => {
  if (!draftRoutine) return;
  const name = (draftRoutine.name || '').trim();
  const exs = draftRoutine.exercises
    .map(e => ({ name: (e.name || '').trim(), sets: Math.max(1, parseInt(e.sets, 10) || 3) }))
    .filter(e => e.name);

  if (!name) { showToast('Give the routine a name'); return; }
  if (exs.length === 0) { showToast('Add at least one exercise'); return; }

  const linked = promptAddNewExercises(exs.map(e => e.name));
  exs.forEach(e => { e.exerciseId = linked.get(e.name.toLowerCase()) || null; });

  if (draftRoutine.id) {
    const r = routines.find(x => x.id === draftRoutine.id);
    r.name = name;
    r.exercises = exs;
  } else {
    routines.push({ id: uid(), name, exercises: exs });
  }
  saveRoutines(routines);
  closeRoutineEditor();
  renderRoutineList();
  populateRoutineSelect();
  showToast('Routine saved ✓');
});

/* ---------- EXERCISES VIEW (library) ---------- */
const exerciseLibraryListEl = document.getElementById('exerciseLibraryList');
const newExerciseInput = document.getElementById('newExerciseInput');

function renderExerciseLibrary() {
  const sorted = [...exerciseLibrary].sort((a, b) => a.name.localeCompare(b.name));

  if (sorted.length === 0) {
    exerciseLibraryListEl.innerHTML = `
      <div class="empty-state">
        <div class="big">💪</div>
        No exercises saved yet.<br>Add the ones you use often for quicker autocomplete on the Workout and Routines tabs.
      </div>`;
    return;
  }

  exerciseLibraryListEl.innerHTML = '';
  sorted.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'session-card';
    row.innerHTML = `
      <div class="session-head" style="cursor:default;">
        <div class="date" style="font-size:15px;">${escapeHtml(entry.name)}${entry.inverted ? '<span class="inverted-tag">ASSIST</span>' : ''}${entry.kind === 'cardio' ? '<span class="cardio-tag">CARDIO</span>' : ''}</div>
        <div class="row" style="flex:0 0 auto; gap:8px;">
          <button class="btn btn-secondary btn-sm" data-role="rename-ex">Rename</button>
          <button class="btn btn-danger btn-sm" data-role="delete-ex">Delete</button>
        </div>
      </div>
      <div class="session-body open" style="padding-top:10px;">
        <label class="ex-opt">
          <input type="checkbox" data-role="cardio-ex" ${entry.kind === 'cardio' ? 'checked' : ''}>
          <span><strong>Cardio</strong> — log time, distance and incline instead of weight and reps</span>
        </label>
        <label class="ex-opt" data-role="invert-wrap" ${entry.kind === 'cardio' ? 'hidden' : ''}>
          <input type="checkbox" data-role="invert-ex" ${entry.inverted ? 'checked' : ''}>
          <span>Weight logged is <strong>assistance</strong> — lower is better (e.g. assisted chin-ups)</span>
        </label>
      </div>
    `;
    row.querySelector('[data-role="cardio-ex"]').addEventListener('change', (e) => {
      entry.kind = e.target.checked ? 'cardio' : 'strength';
      // "Assistance" is a weight concept; it means nothing for a treadmill.
      if (entry.kind === 'cardio') entry.inverted = false;
      saveExerciseLibrary(exerciseLibrary);
      renderExerciseLibrary();
      showToast(entry.kind === 'cardio'
        ? 'Now logged as time and distance'
        : 'Back to weight and reps');
    });
    row.querySelector('[data-role="invert-ex"]').addEventListener('change', (e) => {
      entry.inverted = e.target.checked;
      saveExerciseLibrary(exerciseLibrary);
      renderExerciseLibrary();
      showToast(entry.inverted
        ? 'Charts for this exercise now read lower = better'
        : 'Charts back to higher = better');
    });
    row.querySelector('[data-role="rename-ex"]').addEventListener('click', () => {
      const input = prompt('Rename exercise:', entry.name);
      if (input === null) return; // cancelled
      const trimmed = input.trim();
      if (!trimmed) { showToast('Name cannot be empty'); return; }
      if (exerciseLibrary.some(e => e.id !== entry.id && e.name.toLowerCase() === trimmed.toLowerCase())) {
        showToast('Another exercise already has that name');
        return;
      }
      entry.name = trimmed;
      saveExerciseLibrary(exerciseLibrary);
      renderExerciseLibrary();
      refreshExerciseDatalist();
      showToast('Renamed ✓ — updated everywhere it\'s linked');
    });
    row.querySelector('[data-role="delete-ex"]').addEventListener('click', () => {
      if (confirm(`Remove "${entry.name}" from your exercise library? Anything already logged keeps showing this name, it just won't auto-update anymore.`)) {
        exerciseLibrary = exerciseLibrary.filter(e => e.id !== entry.id);
        saveExerciseLibrary(exerciseLibrary);
        renderExerciseLibrary();
        refreshExerciseDatalist();
      }
    });
    exerciseLibraryListEl.appendChild(row);
  });
}

document.getElementById('addLibraryExerciseBtn').addEventListener('click', () => {
  const name = newExerciseInput.value.trim();
  if (!name) { showToast('Type an exercise name first'); return; }
  if (findExerciseByName(name)) {
    showToast('Already in your library');
    newExerciseInput.value = '';
    return;
  }
  exerciseLibrary.push({ id: uid(), name });
  saveExerciseLibrary(exerciseLibrary);
  newExerciseInput.value = '';
  renderExerciseLibrary();
  refreshExerciseDatalist();
  showToast(`Added "${name}"`);
});

/* ---------- HISTORY VIEW ---------- */
const historyListEl = document.getElementById('historyList');

// Like displayExerciseName, but for the routine a session was started from —
// resolves to the routine's current name if it still exists, else the name
// captured when the workout was started.
function displayRoutineName(session) {
  if (session.routineId) {
    const r = routines.find(x => x.id === session.routineId);
    if (r) return r.name;
  }
  return session.routineName || null;
}

function renderHistory() {
  const sorted = [...sessions].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

  if (sorted.length === 0) {
    historyListEl.innerHTML = `
      <div class="empty-state">
        <div class="big">🏋️</div>
        No workouts logged yet.<br>Head to the Log tab to add your first session.
      </div>`;
    return;
  }

  historyListEl.innerHTML = '';
  sorted.forEach(session => {
    if (editingSessionId === session.id) {
      historyListEl.appendChild(renderSessionEditorCard(session));
      return;
    }
    const vol = sessionVolume(session);
    const card = document.createElement('div');
    card.className = 'session-card';
    const isOpen = openSessionIds.has(session.id);
    const rName = displayRoutineName(session);

    card.innerHTML = `
      <div class="session-head" data-role="head">
        <div>
          <div class="date">${fmtDate(session.date)}</div>
          <div class="meta">${rName ? escapeHtml(rName) + ' · ' : ''}${session.exercises.length} exercise${session.exercises.length !== 1 ? 's' : ''}${session.durationSeconds != null ? ' · ' + formatDuration(session.durationSeconds) : ''}${sessionCardioMinutes(session) > 0 ? ' · ' + Math.round(sessionCardioMinutes(session)) + ' min cardio' : ''}</div>
        </div>
        <div class="vol">${fmtNum(vol)}<div class="meta">total vol</div></div>
      </div>
      <div class="session-body ${isOpen ? 'open' : ''}" data-role="body">
        ${session.exercises.map(ex => {
          const cardio = exerciseIsCardio(ex);
          const right = cardio
            ? formatDuration(cardioSeconds(ex.sets))
            : `${fmtNum(exerciseVolume(ex))} vol`;
          const detail = cardio
            ? escapeHtml(cardioSummary(ex.sets))
            : ex.sets.map(s => `${s.weight}×${s.reps}`).join('  ·  ');
          return `
          <div class="ex-row">
            <div class="ex-name"><span>${escapeHtml(displayExerciseName(ex))}${cardio ? '<span class="cardio-tag">CARDIO</span>' : ''}</span><span class="vol">${right}</span></div>
            <div class="sets">${detail}</div>
            ${ex.notes ? `<div class="ex-notes">📝 ${escapeHtml(ex.notes)}</div>` : ''}
          </div>
        `; }).join('')}
        <div class="session-actions" style="justify-content:space-between;">
          <button class="btn btn-secondary btn-sm" data-role="edit">Edit</button>
          <button class="btn btn-danger btn-sm" data-role="delete">Delete Session</button>
        </div>
      </div>
    `;

    card.querySelector('[data-role="head"]').addEventListener('click', () => {
      if (openSessionIds.has(session.id)) openSessionIds.delete(session.id);
      else openSessionIds.add(session.id);
      renderHistory();
    });

    card.querySelector('[data-role="edit"]').addEventListener('click', (e) => {
      e.stopPropagation();
      editingSessionId = session.id;
      openSessionIds.add(session.id);
      renderHistory();
    });

    card.querySelector('[data-role="delete"]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Delete workout from ${fmtDate(session.date)}? This can't be undone.`)) {
        sessions = sessions.filter(s => s.id !== session.id);
        saveSessions(sessions);
        refreshExerciseDatalist();
        renderHistory();
        scheduleSync();
      }
    });

    historyListEl.appendChild(card);
  });
}

/* Editor for a workout that's already been saved. Works on a deep copy so
   Cancel really cancels, and writes back over the original id on Save — which
   keeps the sync keys stable, so corrected rows update in the spreadsheet
   instead of appearing twice. */
function renderSessionEditorCard(session) {
  const draft = {
    ...session,
    exercises: session.exercises.map(ex => ({ ...ex, sets: ex.sets.map(s => ({ ...s })) })),
  };

  const card = document.createElement('div');
  card.className = 'session-card';

  const head = document.createElement('div');
  head.className = 'session-head';
  head.style.cursor = 'default';
  head.innerHTML = `
    <div>
      <div class="date">${fmtDate(session.date)}</div>
      <div class="meta">Editing</div>
    </div>
  `;
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'session-body open';
  card.appendChild(body);

  function paint() {
    body.innerHTML = '<div class="editing-banner">Fix a weight, a rep count, or a note. Removing every set of an exercise removes the exercise.</div>';

    draft.exercises.forEach((ex, exIdx) => {
      const wrap = document.createElement('div');
      wrap.className = 'ex-row';

      const nameRow = document.createElement('div');
      nameRow.className = 'edit-ex-name';
      nameRow.innerHTML = `
        <span>${escapeHtml(displayExerciseName(ex))}</span>
        <button class="btn btn-danger btn-sm" data-role="rm-ex">Remove</button>
      `;
      nameRow.querySelector('[data-role="rm-ex"]').addEventListener('click', () => {
        draft.exercises.splice(exIdx, 1);
        paint();
      });
      wrap.appendChild(nameRow);

      const cardio = exerciseIsCardio(ex);
      ex.sets.forEach((set, setIdx) => {
        const row = document.createElement('div');
        row.className = 'edit-row';
        row.innerHTML = cardio
          ? `
          <span class="set-idx">${setIdx + 1}</span>
          <input type="number" inputmode="numeric" step="1" min="0" value="${boutToFields(set).mm}" data-role="e-min" placeholder="Min">
          <input type="number" inputmode="numeric" step="1" min="0" value="${boutToFields(set).ss}" data-role="e-sec" placeholder="Sec">
          <input type="number" inputmode="decimal" step="any" min="0" value="${set.distanceMi ?? ''}" data-role="e-dist" placeholder="Miles">
          <input type="number" inputmode="decimal" step="any" min="0" value="${set.inclinePct ?? ''}" data-role="e-incline" placeholder="Incl %">
          <button class="remove-set" data-role="e-rm" title="Remove">–</button>
        `
          : `
          <span class="set-idx">${setIdx + 1}</span>
          <input type="number" inputmode="decimal" step="any" min="0" value="${set.weight}" data-role="e-weight" placeholder="Weight">
          <input type="number" inputmode="numeric" step="1" min="0" value="${set.reps}" data-role="e-reps" placeholder="Reps">
          <button class="remove-set" data-role="e-rm" title="Remove set">–</button>
        `;
        if (cardio) {
          // Seed the edit fields so an untouched row keeps its existing duration.
          const seeded = boutToFields(set);
          set.mm = seeded.mm; set.ss = seeded.ss;
          row.querySelector('[data-role="e-min"]').addEventListener('input', (e) => { set.mm = e.target.value; });
          row.querySelector('[data-role="e-sec"]').addEventListener('input', (e) => { set.ss = e.target.value; });
          row.querySelector('[data-role="e-dist"]').addEventListener('input', (e) => { set.distanceMi = e.target.value; });
          row.querySelector('[data-role="e-incline"]').addEventListener('input', (e) => { set.inclinePct = e.target.value; });
        } else {
          row.querySelector('[data-role="e-weight"]').addEventListener('input', (e) => { set.weight = e.target.value; });
          row.querySelector('[data-role="e-reps"]').addEventListener('input', (e) => { set.reps = e.target.value; });
        }
        row.querySelector('[data-role="e-rm"]').addEventListener('click', () => {
          ex.sets.splice(setIdx, 1);
          if (ex.sets.length === 0) draft.exercises.splice(exIdx, 1);
          paint();
        });
        wrap.appendChild(row);
      });

      const notes = document.createElement('div');
      notes.className = 'notes-row';
      notes.innerHTML = `<input type="text" placeholder="Notes (optional)" value="${escapeHtml(ex.notes || '')}" data-role="e-notes">`;
      notes.querySelector('[data-role="e-notes"]').addEventListener('input', (e) => { ex.notes = e.target.value; });
      wrap.appendChild(notes);

      body.appendChild(wrap);
    });

    const actions = document.createElement('div');
    actions.className = 'session-actions';
    actions.style.justifyContent = 'space-between';
    actions.innerHTML = `
      <button class="btn btn-secondary btn-sm" data-role="cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" data-role="save">Save Changes</button>
    `;
    actions.querySelector('[data-role="cancel"]').addEventListener('click', () => {
      editingSessionId = null;
      renderHistory();
    });
    function commitEdit(cleaned) {
      if (cleaned.length === 0) {
        showToast('A workout needs at least one set — delete the session instead');
        return;
      }
      const idx = sessions.findIndex(s => s.id === session.id);
      if (idx !== -1) {
        sessions[idx] = { ...sessions[idx], exercises: cleaned, editedAt: new Date().toISOString() };
        saveSessions(sessions);
      }
      editingSessionId = null;
      refreshExerciseDatalist();
      renderHistory();
      showToast('Workout updated ✓');
      scheduleSync();
    }

    actions.querySelector('[data-role="save"]').addEventListener('click', () => {
      // Same guard as End Workout — an edit that blanks a rep count shouldn't
      // quietly delete the set it belonged to.
      const audit = auditDraftExercises(draft.exercises);
      const cleaned = audit.exercises.map((clean, i) => ({ ...draft.exercises[audit.keptIndexes[i]], ...clean }));

      if (audit.issues.length > 0) {
        showSaveGuard(audit.issues, {
          onFix: () => {},
          onDiscard: () => commitEdit(cleaned),
        });
        return;
      }
      commitEdit(cleaned);
    });
    body.appendChild(actions);
  }

  paint();
  return card;
}

/* ---------- Backup / Export / Import ---------- */
function buildBackupPayload() {
  return {
    format: 'workout-tracker-backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    sessions,
    routines,
    exerciseLibrary,
    bodyWeights,
  };
}

function csvEscape(val) {
  const str = String(val == null ? '' : val);
  return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

// Strength sets only — cardio has its own file, because forcing both into one
// table means half the columns are always blank.
function buildCsv() {
  const rows = [['Date', 'Routine', 'Exercise', 'Set', 'Weight', 'Reps', 'Volume', 'Notes']];
  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  sorted.forEach(s => {
    const routineName = displayRoutineName(s) || '';
    s.exercises.forEach(ex => {
      if (exerciseIsCardio(ex)) return;
      const exName = displayExerciseName(ex);
      ex.sets.forEach((set, i) => {
        rows.push([
          s.date,
          routineName,
          exName,
          i + 1,
          set.weight,
          set.reps,
          (Number(set.weight) || 0) * (Number(set.reps) || 0),
          ex.notes || '',
        ]);
      });
    });
  });
  return rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
}

function buildCardioCsv() {
  const rows = [['Date', 'Routine', 'Exercise', 'Interval', 'Duration', 'Minutes', 'Distance (mi)', 'Incline %', 'Avg Speed (mph)', 'Pace (min/mi)', 'Notes']];
  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  sorted.forEach(s => {
    const routineName = displayRoutineName(s) || '';
    s.exercises.forEach(ex => {
      if (!exerciseIsCardio(ex)) return;
      const exName = displayExerciseName(ex);
      ex.sets.forEach((bout, i) => {
        const one = [bout];
        rows.push([
          s.date,
          routineName,
          exName,
          i + 1,
          formatDuration(boutSeconds(bout)),
          Math.round(boutSeconds(bout) / 60 * 100) / 100,
          bout.distanceMi,
          bout.inclinePct,
          Math.round(cardioSpeedMph(one) * 100) / 100,
          fmtPace(cardioPace(one)),
          ex.notes || '',
        ]);
      });
    });
  });
  return rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
}

function triggerDownload(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById('exportJsonBtn').addEventListener('click', () => {
  triggerDownload(`workout-backup-${todayStr()}.json`, JSON.stringify(buildBackupPayload(), null, 2), 'application/json');
  showToast('Backup downloaded');
});

document.getElementById('exportCsvBtn').addEventListener('click', () => {
  triggerDownload(`workout-data-${todayStr()}.csv`, buildCsv(), 'text/csv');
  showToast('CSV downloaded');
});

function buildWeightCsv() {
  const rows = [['Date', 'Weight']];
  sortedBodyWeights().forEach(w => rows.push([w.date, w.weight]));
  return rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
}

document.getElementById('exportCardioCsvBtn').addEventListener('click', () => {
  const hasCardio = sessions.some(s => s.exercises.some(exerciseIsCardio));
  if (!hasCardio) { showToast('No cardio logged yet'); return; }
  triggerDownload(`cardio-data-${todayStr()}.csv`, buildCardioCsv(), 'text/csv');
  showToast('Cardio CSV downloaded');
});

document.getElementById('exportWeightCsvBtn').addEventListener('click', () => {
  if (bodyWeights.length === 0) { showToast('No weigh-ins logged yet'); return; }
  triggerDownload(`bodyweight-${todayStr()}.csv`, buildWeightCsv(), 'text/csv');
  showToast('Weight CSV downloaded');
});

// Merge an imported backup into current data. Never deletes or overwrites anything
// that's already there — only adds records whose id isn't already present. Returns
// counts of what was actually added, or throws if the file doesn't look like a backup.
function applyImportedBackup(data) {
  if (!data || !Array.isArray(data.sessions) || !Array.isArray(data.routines) || !Array.isArray(data.exerciseLibrary)) {
    throw new Error('Not a valid workout tracker backup file');
  }

  const existingSessionIds = new Set(sessions.map(s => s.id));
  const newSessions = data.sessions.filter(s => s && s.id && !existingSessionIds.has(s.id));
  sessions = sessions.concat(newSessions);

  const existingRoutineIds = new Set(routines.map(r => r.id));
  const newRoutines = data.routines.map(normalizeRoutine).filter(r => r && r.id && !existingRoutineIds.has(r.id));
  routines = routines.concat(newRoutines);

  const existingLibIds = new Set(exerciseLibrary.map(e => e.id));
  const newLibEntries = normalizeExerciseLibrary(data.exerciseLibrary).filter(e => e && e.id && !existingLibIds.has(e.id));
  exerciseLibrary = exerciseLibrary.concat(newLibEntries);

  // Body weights arrived in v2 backups; older files simply won't have the key.
  // Matched on date rather than id, since there is only ever one weigh-in per day.
  const existingWeightDates = new Set(bodyWeights.map(w => w.date));
  const newWeights = (Array.isArray(data.bodyWeights) ? data.bodyWeights : [])
    .filter(w => w && w.date && !existingWeightDates.has(w.date))
    .map(w => ({ id: w.id || uid(), date: w.date, weight: Number(w.weight) || 0, loggedAt: w.loggedAt || null }));
  bodyWeights = bodyWeights.concat(newWeights);

  saveSessions(sessions);
  saveRoutines(routines);
  saveExerciseLibrary(exerciseLibrary);
  saveBodyWeights(bodyWeights);

  return {
    sessions: newSessions.length,
    routines: newRoutines.length,
    exercises: newLibEntries.length,
    weights: newWeights.length,
  };
}

const importFileInput = document.getElementById('importFileInput');
document.getElementById('importJsonBtn').addEventListener('click', () => importFileInput.click());
importFileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const added = applyImportedBackup(data);
      refreshExerciseDatalist();
      populateRoutineSelect();
      renderHistory();
      renderBodyWeightCard();
      showToast(`Restored ${added.sessions} workout${added.sessions !== 1 ? 's' : ''}, ${added.routines} routine${added.routines !== 1 ? 's' : ''}, ${added.exercises} exercise${added.exercises !== 1 ? 's' : ''}, ${added.weights} weigh-in${added.weights !== 1 ? 's' : ''}`);
    } catch (err) {
      console.error(err);
      showToast("Couldn't read that file — is it a workout tracker backup?");
    } finally {
      importFileInput.value = '';
    }
  };
  reader.readAsText(file);
});

/* ---------- CLOUD SYNC ----------
   iOS gives an installed PWA no background execution at all — no Background Sync,
   no Periodic Background Sync, no Background Fetch. So there is no such thing as a
   nightly push from here. Instead we sync whenever the app is actually in front of
   the user: on launch, when it becomes visible again, and after anything is saved.
   Since a weigh-in happens daily, that works out to roughly daily in practice.

   Every row carries a stable key, and the receiving Apps Script upserts on it, so
   re-sending the same data is harmless. That means we can just re-send a window of
   recent data every time instead of maintaining a fragile pending-queue. */
const SYNC_WINDOW_DAYS = 180;
const SYNC_MIN_INTERVAL_MS = 60 * 1000;
let syncInFlight = false;
let lastSyncAttempt = 0;

const syncUrlInput = document.getElementById('syncUrlInput');
const syncTokenInput = document.getElementById('syncTokenInput');
const syncStatusEl = document.getElementById('syncStatus');

function syncWindowStart() {
  return new Date(Date.now() - SYNC_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
}

// One row per logged set, keyed by session id + position so the same set always
// lands on the same spreadsheet row no matter how many times it is sent.
function buildSyncPayload() {
  const since = syncWindowStart();
  const rows = [];
  const cardioRows = [];
  sessions
    .filter(s => s.date >= since)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .forEach(s => {
      const routineName = displayRoutineName(s) || '';
      s.exercises.forEach((ex, exIdx) => {
        const exName = displayExerciseName(ex);
        const cardio = exerciseIsCardio(ex);
        ex.sets.forEach((set, setIdx) => {
          // Same key scheme for both, so a set that changes kind can't end up
          // duplicated across the two tabs.
          const key = `${s.id}:${exIdx}:${setIdx}`;
          if (cardio) {
            const one = [set];
            cardioRows.push({
              key,
              date: s.date,
              routine: routineName,
              exercise: exName,
              interval: setIdx + 1,
              seconds: boutSeconds(set),
              minutes: Math.round(boutSeconds(set) / 60 * 100) / 100,
              distanceMi: Number(set.distanceMi) || 0,
              inclinePct: Number(set.inclinePct) || 0,
              speedMph: Math.round(cardioSpeedMph(one) * 100) / 100,
              paceMinPerMi: Math.round(cardioPace(one) * 100) / 100,
              notes: ex.notes || '',
            });
          } else {
            rows.push({
              key,
              date: s.date,
              routine: routineName,
              exercise: exName,
              set: setIdx + 1,
              weight: Number(set.weight) || 0,
              reps: Number(set.reps) || 0,
              volume: (Number(set.weight) || 0) * (Number(set.reps) || 0),
              notes: ex.notes || '',
            });
          }
        });
      });
    });

  return {
    token: syncConfig.token || '',
    source: 'workout-tracker',
    sentAt: new Date().toISOString(),
    weights: sortedBodyWeights().map(w => ({ id: w.id, date: w.date, weight: Number(w.weight) || 0 })),
    sets: rows,
    cardio: cardioRows,
  };
}

// Sync state shows in two places: full text inside the accordion, and a short
// version on the closed summary line so you can see it without expanding.
function renderSyncStatus() {
  const summaryEl = document.getElementById('accSyncSummary');
  const set = (cls, full, brief) => {
    syncStatusEl.className = 'sync-status' + (cls ? ' ' + cls : '');
    syncStatusEl.textContent = full;
    if (summaryEl) {
      summaryEl.className = 'acc-sub' + (cls ? ' ' + cls : '');
      summaryEl.textContent = brief;
    }
  };

  if (!syncConfig.url) {
    set('', 'Not configured. Paste your Apps Script URL above to turn sync on.', 'sync off');
  } else if (syncInFlight) {
    set('', 'Syncing…', 'syncing…');
  } else if (syncConfig.lastError) {
    set('err', `Last sync failed: ${syncConfig.lastError}`, 'sync failed');
  } else if (syncConfig.lastSyncedAt) {
    const d = new Date(syncConfig.lastSyncedAt);
    set('ok', `Last synced ${d.toLocaleString()}`, `synced ${shortWhen(d)}`);
  } else {
    set('', 'Configured — not synced yet.', 'not synced yet');
  }
}

// "just now" / "14m ago" / "3h ago" / "Aug 29" — short enough for the summary line.
function shortWhen(date) {
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return fmtDateShort(date.toISOString().slice(0, 10));
}

async function syncNow({ silent = false } = {}) {
  if (!syncConfig.url) {
    if (!silent) showToast('Add your Apps Script URL first');
    return false;
  }
  if (syncInFlight) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (!silent) showToast('Offline — will sync next time you open the app');
    return false;
  }

  syncInFlight = true;
  lastSyncAttempt = Date.now();
  renderSyncStatus();

  try {
    // text/plain keeps this a CORS "simple request", so the browser skips the
    // preflight OPTIONS that Apps Script cannot answer usefully.
    const res = await fetch(syncConfig.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(buildSyncPayload()),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let body = null;
    try { body = JSON.parse(await res.text()); } catch (e) { /* non-JSON is still a delivery */ }
    if (body && body.ok === false) throw new Error(body.error || 'rejected by script');

    syncConfig.lastSyncedAt = new Date().toISOString();
    syncConfig.lastError = null;
    saveSyncConfig(syncConfig);
    renderSyncStatus();
    if (!silent) {
      const n = body && body.counts
        ? ` (${body.counts.weights} weigh-ins, ${body.counts.sets} sets)`
        : '';
      showToast(`Synced ✓${n}`);
    }
    return true;
  } catch (err) {
    console.error('Sync failed', err);
    syncConfig.lastError = (err && err.message) || 'network error';
    saveSyncConfig(syncConfig);
    renderSyncStatus();
    if (!silent) showToast(`Sync failed: ${syncConfig.lastError}`);
    return false;
  } finally {
    syncInFlight = false;
    renderSyncStatus();
  }
}

// Fire-and-forget background sync, rate limited so saving three things in a row
// doesn't fire three requests.
function scheduleSync() {
  if (!syncConfig.url) return;
  if (Date.now() - lastSyncAttempt < SYNC_MIN_INTERVAL_MS) return;
  syncNow({ silent: true });
}

document.getElementById('syncSaveBtn').addEventListener('click', () => {
  const url = syncUrlInput.value.trim();
  if (url && !/^https:\/\/script\.google\.com\//.test(url)) {
    showToast('That should be a https://script.google.com/... URL');
    return;
  }
  syncConfig.url = url;
  syncConfig.token = syncTokenInput.value.trim();
  syncConfig.lastError = null;
  saveSyncConfig(syncConfig);
  renderSyncStatus();
  showToast(url ? 'Sync settings saved' : 'Sync turned off');
});

document.getElementById('syncNowBtn').addEventListener('click', () => syncNow());

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleSync();
});

/* ---------- CHARTS VIEW ---------- */
const chartExerciseSelect = document.getElementById('chartExerciseSelect');
const chartArea = document.getElementById('chartArea');
let chartInstances = [];

/* For an exercise flagged `inverted` (assisted machines), the logged weight is how
   much the machine took OFF you, so every weight-based metric reads backwards:
   a rising line means you needed more help. These entries relabel themselves and
   flip "Peak" to "Best (lowest)" in that case. Reps are unaffected — more reps is
   still more reps. */
const CHART_METRICS = {
  volume: {
    label: 'Volume Load',
    invertedLabel: 'Assist Volume',
    shortLabel: 'Vol',
    betterIsLower: true,
    compute: setsToVolume,
    format: fmtNum,
  },
  avgWeight: {
    label: 'Average Weight',
    invertedLabel: 'Average Assist',
    shortLabel: 'Avg Wt',
    betterIsLower: true,
    compute: setsToAvgWeight,
    format: n => (Math.round(n * 10) / 10).toLocaleString(),
  },
  maxWeight: {
    label: 'Max Weight',
    invertedLabel: 'Least Assist Used',
    shortLabel: 'Max Wt',
    betterIsLower: true,
    compute: sets => sets.reduce((m, s) => Math.max(m, Number(s.weight) || 0), 0),
    // The meaningful PR on an assisted machine is the LOWEST assistance you managed.
    invertedCompute: sets => sets.reduce(
      (m, s) => Math.min(m, Number(s.weight) || 0), Infinity),
    format: fmtNum,
  },
  maxReps: {
    label: 'Max Reps',
    shortLabel: 'Max Reps',
    betterIsLower: false,
    compute: sets => sets.reduce((m, s) => Math.max(m, Number(s.reps) || 0), 0),
    format: n => Math.round(n).toLocaleString(),
  },
};

/* Cardio has no weight or reps, so it gets its own four metrics. Pace is
   "lower is better" for the same reason assisted lifts are — a falling line
   means you covered the same ground faster. */
const CARDIO_CHART_METRICS = {
  minutes: {
    label: 'Duration (min)',
    betterIsLower: false,
    compute: cardioMinutes,
    format: n => (Math.round(n * 10) / 10).toLocaleString(),
  },
  distance: {
    label: 'Distance (mi)',
    betterIsLower: false,
    compute: cardioDistance,
    format: n => (Math.round(n * 100) / 100).toFixed(2),
  },
  speed: {
    label: 'Avg Speed (mph)',
    betterIsLower: false,
    compute: cardioSpeedMph,
    format: n => (Math.round(n * 10) / 10).toFixed(1),
  },
  incline: {
    label: 'Avg Incline (%)',
    betterIsLower: false,
    compute: cardioAvgIncline,
    format: n => (Math.round(n * 10) / 10).toFixed(1),
  },
};

function metricLabel(metric, inverted) {
  return inverted && metric.invertedLabel ? metric.invertedLabel : metric.label;
}

function metricCompute(metric, inverted) {
  return inverted && metric.invertedCompute ? metric.invertedCompute : metric.compute;
}

function setsToVolume(sets) {
  return sets.reduce((sum, s) => sum + (Number(s.weight) || 0) * (Number(s.reps) || 0), 0);
}

// Weighted average weight per rep: ((w1*r1) + (w2*r2) + ...) / (r1 + r2 + ...)
function setsToAvgWeight(sets) {
  const totalReps = sets.reduce((sum, s) => sum + (Number(s.reps) || 0), 0);
  if (totalReps === 0) return 0;
  return setsToVolume(sets) / totalReps;
}

// All sets logged for a given exercise (matched by library id when linked), grouped
// by date so multiple sessions of the same exercise on the same day combine correctly.
function setsByDateFor(targetKey) {
  const byDate = new Map();
  sessions.forEach(s => {
    s.exercises.forEach(ex => {
      if (exerciseMatchKey(ex) === targetKey) {
        if (!byDate.has(s.date)) byDate.set(s.date, []);
        byDate.get(s.date).push(...ex.sets);
      }
    });
  });
  return byDate;
}

// Chart y-axis min/max: start a bit below the lowest value instead of always at 0.
function computeAxisRange(values) {
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const range = dataMax - dataMin;
  const margin = range > 0 ? range * 0.1 : Math.max(1, dataMax * 0.1 || 1);
  return {
    min: Math.max(0, Math.floor(dataMin - margin)),
    max: Math.ceil(dataMax + margin),
  };
}

/* Body weight gets its own chart above the exercise picker, since it isn't tied to
   any exercise. Plots the raw daily points plus a 7-day rolling average — the raw
   line is noisy enough (water, food, salt) that the average is the one to read. */
let weightChartInstance = null;

function renderWeightChart() {
  const area = document.getElementById('weightChartArea');
  if (!area) return;
  if (weightChartInstance) { weightChartInstance.destroy(); weightChartInstance = null; }

  const all = sortedBodyWeights();
  if (all.length === 0) {
    area.innerHTML = '';
    return;
  }

  const avg7 = bodyWeightAverage(7);
  const latest = all[all.length - 1];
  const first = all[0];
  const change = latest.weight - first.weight;

  area.innerHTML = `
    <div class="chart-card">
      <div class="chart-card-head">
        <div>
          <div class="chart-card-title">Body Weight</div>
          <div class="chart-card-note">${all.length} weigh-in${all.length !== 1 ? 's' : ''} since ${fmtDateShort(first.date)}</div>
        </div>
        <div class="chart-card-stats">
          Latest <strong>${(Math.round(latest.weight * 10) / 10).toFixed(1)}</strong>
          &middot; 7-day <strong>${avg7 ? (Math.round(avg7.avg * 10) / 10).toFixed(1) : '-'}</strong>
          &middot; Change <strong>${change >= 0 ? '+' : ''}${(Math.round(change * 10) / 10).toFixed(1)}</strong>
        </div>
      </div>
      <div class="chart-wrap-sm"><canvas id="chart-bodyweight"></canvas></div>
    </div>
  `;

  if (typeof Chart === 'undefined') return;

  // Trailing 7-day mean at each point, over whatever entries exist in that window.
  const rolling = all.map((w, i) => {
    const windowStart = new Date(new Date(w.date + 'T00:00:00').getTime() - 6 * 86400000)
      .toISOString().slice(0, 10);
    const win = all.slice(0, i + 1).filter(x => x.date >= windowStart);
    return win.reduce((s, x) => s + x.weight, 0) / win.length;
  });

  const range = computeAxisRange(all.map(w => w.weight).concat(rolling));
  const ctx = document.getElementById('chart-bodyweight').getContext('2d');
  weightChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: all.map(w => fmtDate(w.date)),
      datasets: [
        {
          label: 'Daily',
          data: all.map(w => w.weight),
          borderColor: 'rgba(154,162,177,0.5)',
          pointBackgroundColor: 'rgba(154,162,177,0.7)',
          pointRadius: 2,
          borderWidth: 1,
          tension: 0.2,
          fill: false,
        },
        {
          label: '7-day average',
          data: rolling,
          borderColor: '#5b8cff',
          backgroundColor: 'rgba(91,140,255,0.15)',
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.25,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#9aa2b1', maxRotation: 0, autoSkip: true, font: { size: 10 } }, grid: { color: '#2a2f3a' } },
        y: { ticks: { color: '#9aa2b1', font: { size: 10 } }, grid: { color: '#2a2f3a' }, min: range.min, max: range.max },
      },
    },
  });
}

function renderCharts() {
  renderWeightChart();
  const names = allExerciseNames(sessions);

  if (names.length === 0) {
    chartExerciseSelect.innerHTML = '';
    chartArea.innerHTML = `
      <div class="empty-state">
        <div class="big">📈</div>
        No data yet.<br>Log a few workouts to see trends here.
      </div>`;
    return;
  }

  const prevSelected = chartExerciseSelect.value;
  chartExerciseSelect.innerHTML = names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  if (names.includes(prevSelected)) chartExerciseSelect.value = prevSelected;

  drawChartsFor(chartExerciseSelect.value);
}

chartExerciseSelect.addEventListener('change', () => drawChartsFor(chartExerciseSelect.value));

// If Chart.js was still loading (or a CDN attempt failed and a fallback kicked in) when
// the user first opened this tab, redraw automatically the moment it becomes available.
window.addEventListener('chartjs-ready', () => {
  if (currentView === 'charts') renderCharts();
});

// Renders all four metrics (Volume Load, Average Weight, Max Weight, Max Reps) at once,
// each as its own compact chart card with its own independently-scaled y-axis.
function drawChartsFor(exerciseName) {
  chartInstances.forEach(c => c.destroy());
  chartInstances = [];

  if (!exerciseName) return;
  const targetKey = matchKeyForName(exerciseName);

  const byDate = setsByDateFor(targetKey);
  const dates = [...byDate.keys()].sort((a, b) => a.localeCompare(b));

  if (dates.length === 0) {
    chartArea.innerHTML = `<div class="empty-state">No logged sets yet for this exercise.</div>`;
    return;
  }

  // Cardio exercises get an entirely different metric family — minutes and miles
  // instead of weight and reps.
  const cardio = isCardioExerciseName(exerciseName);
  const METRICS = cardio ? CARDIO_CHART_METRICS : CHART_METRICS;
  const metricKeys = Object.keys(METRICS);
  const inverted = !cardio && isInvertedExerciseName(exerciseName);

  chartArea.innerHTML = `
    <div class="chart-session-count">${dates.length} session${dates.length !== 1 ? 's' : ''} logged</div>
    ${inverted ? `<div class="editing-banner">Assisted exercise — the number you log is how much the machine helps, so <strong>a falling line is progress</strong>.</div>` : ''}
    ${metricKeys.map(key => {
      const m = METRICS[key];
      const lower = inverted && m.betterIsLower;
      return `
      <div class="chart-card">
        <div class="chart-card-head">
          <div>
            <div class="chart-card-title">${metricLabel(m, inverted)}</div>
            ${lower ? '<div class="chart-card-note">lower is better</div>' : ''}
          </div>
          <div class="chart-card-stats">Latest <strong id="latest-${key}">-</strong> &middot; ${lower ? 'Best' : 'Peak'} <strong id="peak-${key}">-</strong></div>
        </div>
        <div class="chart-wrap-sm"><canvas id="chart-${key}"></canvas></div>
      </div>
    `; }).join('')}
  `;

  const chartJsAvailable = typeof Chart !== 'undefined';
  if (!chartJsAvailable) {
    chartArea.insertAdjacentHTML('beforeend', `<div class="empty-state">Chart library unavailable offline on first load. Open once with internet, then it's cached for offline use.</div>`);
  }

  metricKeys.forEach(key => {
    const metric = METRICS[key];
    const lower = inverted && metric.betterIsLower;
    const computeFn = metricCompute(metric, inverted);
    const points = dates.map(d => [d, computeFn(byDate.get(d))]);
    const values = points.map(p => p[1]).map(v => (isFinite(v) ? v : 0));

    document.getElementById(`latest-${key}`).textContent = metric.format(values[values.length - 1]);
    document.getElementById(`peak-${key}`).textContent =
      metric.format(lower ? Math.min(...values) : Math.max(...values));

    if (!chartJsAvailable) return;

    const axisRange = computeAxisRange(values);
    const ctx = document.getElementById(`chart-${key}`).getContext('2d');

    const inst = new Chart(ctx, {
      type: 'line',
      data: {
        labels: points.map(p => fmtDate(p[0])),
        datasets: [{
          label: `${exerciseName} — ${metricLabel(metric, inverted)}`,
          data: values,
          borderColor: '#5b8cff',
          backgroundColor: 'rgba(91,140,255,0.15)',
          pointBackgroundColor: '#5b8cff',
          pointRadius: 3,
          tension: 0.25,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#9aa2b1', maxRotation: 0, autoSkip: true, font: { size: 10 } }, grid: { color: '#2a2f3a' } },
          y: { ticks: { color: '#9aa2b1', font: { size: 10 } }, grid: { color: '#2a2f3a' }, min: axisRange.min, max: axisRange.max },
        },
      },
    });
    chartInstances.push(inst);
  });
}

/* ---------- Init ---------- */
const resumed = loadActiveWorkout();
if (resumed && resumed.activeWorkout && Array.isArray(resumed.draftExercises) && resumed.draftExercises.length) {
  activeWorkout = resumed.activeWorkout;
  draftExercises = resumed.draftExercises;
} else {
  draftExercises.push(newDraftExercise());
}
renderExerciseList();
refreshExerciseDatalist();
populateRoutineSelect();
renderBodyWeightCard();
syncUrlInput.value = syncConfig.url;
syncTokenInput.value = syncConfig.token;
renderSyncStatus();
syncLayoutVars();
setView('log');
if (activeWorkout) startTimerInterval();

// iOS resumes a frozen page rather than re-running JS, so re-stamp today's date
// on the weigh-in card too and take the chance to push anything unsynced.
window.addEventListener('pageshow', () => {
  if (bwDateInput.value < todayStr()) bwDateInput.value = todayStr();
  renderBodyWeightCard();
  scheduleSync();
});

// First sync of the session. Deliberately silent — a failed background sync
// shouldn't greet you with an error toast every time you open the app.
scheduleSync();

/* ---------- Service worker registration & updates ----------
   The service worker already calls skipWaiting()/clients.claim(), so a new version
   takes control on the first launch after a deploy. But taking control doesn't
   reload anything — the HTML and JS already in memory are still the old ones, which
   is why an update used to need a second launch to appear.

   So: reload as soon as the new worker takes over. Except mid-workout, where a
   reload would shut the keyboard and drop a half-typed number; there we just offer
   a button and refresh when the workout ends. */
let swUpdatePending = false;
let swReloading = false;

// Indirected so the update flow can be tested without a real navigation.
function reloadApp() {
  window.location.reload();
}

function applyPendingUpdate() {
  if (swReloading) return;
  swReloading = true;
  showToast('Updating…');
  // A beat so the toast paints before the page goes away.
  setTimeout(() => reloadApp(), 250);
}

function showUpdateBanner() {
  if (document.getElementById('updateBanner')) return;
  const bar = document.createElement('button');
  bar.id = 'updateBanner';
  bar.className = 'update-banner';
  bar.textContent = 'Update ready — tap to refresh';
  bar.addEventListener('click', applyPendingUpdate);
  document.body.appendChild(bar);
}

// Called when a workout finishes, so a deferred update lands at a safe moment.
function applyUpdateIfDeferred() {
  if (swUpdatePending) applyPendingUpdate();
}

if ('serviceWorker' in navigator) {
  // Whether this page was already under a worker's control at load. On a genuine
  // first install there's no controller and controllerchange fires immediately —
  // reloading then would be pointless.
  const hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    if (activeWorkout) {
      swUpdatePending = true;
      showUpdateBanner();
      return;
    }
    applyPendingUpdate();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js')
      .then((reg) => {
        // iOS resumes a frozen page rather than reloading it, so an app left open
        // for days would otherwise never check. Ask on every foreground.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      })
      .catch(() => {});
  });
}
