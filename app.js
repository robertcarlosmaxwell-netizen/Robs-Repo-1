/* ---------- Storage ---------- */
const STORAGE_KEY = 'wt_sessions_v1';
const ROUTINES_KEY = 'wt_routines_v1';
const ACTIVE_WORKOUT_KEY = 'wt_active_workout_v1';
const EXERCISE_LIBRARY_KEY = 'wt_exercise_library_v1';

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
function normalizeExerciseLibrary(list) {
  return (list || []).map(e => (typeof e === 'string' ? { id: uid(), name: e } : e));
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

/* ---------- Volume calculations ---------- */
function exerciseVolume(exercise) {
  return exercise.sets.reduce((sum, s) => sum + (Number(s.weight) || 0) * (Number(s.reps) || 0), 0);
}

function sessionVolume(session) {
  return session.exercises.reduce((sum, ex) => sum + exerciseVolume(ex), 0);
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
  return { date: session.date, sets: ex.sets, volume: exerciseVolume(ex) };
}

/* ---------- App state ---------- */
let sessions = loadSessions();
let routines = loadRoutines().map(normalizeRoutine);
let exerciseLibrary = normalizeExerciseLibrary(loadExerciseLibrary());
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
  charts: ['Progress', 'Volume load over time'],
};

function setView(name) {
  currentView = name;
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

function refreshExerciseDatalist() {
  exerciseNamesDatalist.innerHTML = knownExerciseNames()
    .map(n => `<option value="${escapeHtml(n)}">`).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

let draftExercises = []; // [{ id, name, sets: [{weight, reps}], notes }]

function newDraftExercise(name = '') {
  return { id: uid(), name, sets: [{ weight: '', reps: '' }], notes: '' };
}

// Refresh the "PREV" header + per-set previous values for one exercise block
// without rebuilding the DOM (keeps focus/cursor position while typing the name).
function updateBlockPrevData(block, ex) {
  const perf = lastPerformanceFor(ex.name);
  const headerPrevEl = block.querySelector('[data-role="prev-header"]');
  if (headerPrevEl) headerPrevEl.textContent = perf ? `PREV (${fmtDateShort(perf.date)})` : 'PREV';
  block.querySelectorAll('[data-role="prev-val"]').forEach((el, si) => {
    const s = perf && perf.sets[si];
    el.textContent = s ? `${s.weight}×${s.reps}` : '—';
  });
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

    const notesWrap = document.createElement('div');
    notesWrap.className = 'notes-row';
    notesWrap.innerHTML = `<input type="text" placeholder="Notes (optional)" value="${escapeHtml(ex.notes || '')}" data-role="notes">`;
    notesWrap.querySelector('[data-role="notes"]').addEventListener('input', (e) => { ex.notes = e.target.value; });
    block.appendChild(notesWrap);

    head.querySelector('[data-role="ex-name"]').addEventListener('input', (e) => {
      ex.name = e.target.value;
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

endWorkoutBtn.addEventListener('click', () => {
  if (!activeWorkout) return;
  const durationSeconds = Math.max(0, Math.floor((Date.now() - activeWorkout.startTime) / 1000));
  stopTimerInterval();

  const cleanExercises = draftExercises
    .map(ex => ({
      name: (ex.name || '').trim(),
      notes: (ex.notes || '').trim(),
      sets: ex.sets
        .filter(s => s.weight !== '' && s.reps !== '' && !isNaN(Number(s.weight)) && !isNaN(Number(s.reps)))
        .map(s => ({ weight: Number(s.weight), reps: Number(s.reps) })),
    }))
    .filter(ex => ex.name && ex.sets.length > 0);

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
  } else {
    showToast('Workout ended — no sets logged, nothing saved');
  }

  activeWorkout = null;
  clearActiveWorkoutStorage();
  draftExercises = [newDraftExercise()];
  renderExerciseList();
  sessionDateInput.value = todayStr();
  routineSelect.value = '';
  showPreWorkoutScreen();
});

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
    row.innerHTML = `
      <span class="set-idx">${i + 1}</span>
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
    row.querySelector('[data-role="remove-rex"]').addEventListener('click', () => {
      draftRoutine.exercises.splice(i, 1);
      if (draftRoutine.exercises.length === 0) draftRoutine.exercises.push({ name: '', sets: '', exerciseId: null });
      renderRoutineExerciseInputs();
    });
    routineExerciseListEl.appendChild(row);
  });
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
        <div class="date" style="font-size:15px;">${escapeHtml(entry.name)}</div>
        <div class="row" style="flex:0 0 auto; gap:8px;">
          <button class="btn btn-secondary btn-sm" data-role="rename-ex">Rename</button>
          <button class="btn btn-danger btn-sm" data-role="delete-ex">Delete</button>
        </div>
      </div>
    `;
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
    const vol = sessionVolume(session);
    const card = document.createElement('div');
    card.className = 'session-card';
    const isOpen = openSessionIds.has(session.id);
    const rName = displayRoutineName(session);

    card.innerHTML = `
      <div class="session-head" data-role="head">
        <div>
          <div class="date">${fmtDate(session.date)}</div>
          <div class="meta">${rName ? escapeHtml(rName) + ' · ' : ''}${session.exercises.length} exercise${session.exercises.length !== 1 ? 's' : ''}${session.durationSeconds != null ? ' · ' + formatDuration(session.durationSeconds) : ''}</div>
        </div>
        <div class="vol">${fmtNum(vol)}<div class="meta">total vol</div></div>
      </div>
      <div class="session-body ${isOpen ? 'open' : ''}" data-role="body">
        ${session.exercises.map(ex => `
          <div class="ex-row">
            <div class="ex-name"><span>${escapeHtml(displayExerciseName(ex))}</span><span class="vol">${fmtNum(exerciseVolume(ex))} vol</span></div>
            <div class="sets">${ex.sets.map(s => `${s.weight}×${s.reps}`).join('  ·  ')}</div>
            ${ex.notes ? `<div class="ex-notes">📝 ${escapeHtml(ex.notes)}</div>` : ''}
          </div>
        `).join('')}
        <div class="session-actions">
          <button class="btn btn-danger btn-sm" data-role="delete">Delete Session</button>
        </div>
      </div>
    `;

    card.querySelector('[data-role="head"]').addEventListener('click', () => {
      if (openSessionIds.has(session.id)) openSessionIds.delete(session.id);
      else openSessionIds.add(session.id);
      renderHistory();
    });

    card.querySelector('[data-role="delete"]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Delete workout from ${fmtDate(session.date)}? This can't be undone.`)) {
        sessions = sessions.filter(s => s.id !== session.id);
        saveSessions(sessions);
        refreshExerciseDatalist();
        renderHistory();
      }
    });

    historyListEl.appendChild(card);
  });
}

/* ---------- CHARTS VIEW ---------- */
const chartExerciseSelect = document.getElementById('chartExerciseSelect');
const chartArea = document.getElementById('chartArea');
let chartInstance = null;

function renderCharts() {
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

  drawChartFor(chartExerciseSelect.value);
}

chartExerciseSelect.addEventListener('change', () => drawChartFor(chartExerciseSelect.value));

// If Chart.js was still loading (or a CDN attempt failed and a fallback kicked in) when
// the user first opened this tab, redraw automatically the moment it becomes available.
window.addEventListener('chartjs-ready', () => {
  if (currentView === 'charts') renderCharts();
});

function drawChartFor(exerciseName) {
  if (!exerciseName) return;
  const targetKey = matchKeyForName(exerciseName);

  // Aggregate volume by date for this exercise (matched by library ID when linked,
  // so a rename doesn't split the trend line into two separate exercises)
  const byDate = new Map();
  sessions.forEach(s => {
    s.exercises.forEach(ex => {
      if (exerciseMatchKey(ex) === targetKey) {
        const v = exerciseVolume(ex);
        byDate.set(s.date, (byDate.get(s.date) || 0) + v);
      }
    });
  });

  const points = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  chartArea.innerHTML = `
    <div class="chart-wrap"><canvas id="volChart"></canvas></div>
    <div class="stat-row">
      <div class="stat-box"><div class="label">Sessions</div><div class="value" id="statSessions">-</div></div>
      <div class="stat-box"><div class="label">Latest Vol</div><div class="value" id="statLatest">-</div></div>
      <div class="stat-box"><div class="label">Peak Vol</div><div class="value" id="statPeak">-</div></div>
    </div>
  `;

  if (points.length === 0) return;

  document.getElementById('statSessions').textContent = points.length;
  document.getElementById('statLatest').textContent = fmtNum(points[points.length - 1][1]);
  document.getElementById('statPeak').textContent = fmtNum(Math.max(...points.map(p => p[1])));

  const ctx = document.getElementById('volChart').getContext('2d');
  if (chartInstance) chartInstance.destroy();

  if (typeof Chart === 'undefined') {
    chartArea.querySelector('.chart-wrap').innerHTML = `<div class="empty-state">Chart library unavailable offline on first load. Open once with internet, then it's cached for offline use.</div>`;
    return;
  }

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map(p => fmtDate(p[0])),
      datasets: [{
        label: exerciseName,
        data: points.map(p => p[1]),
        borderColor: '#5b8cff',
        backgroundColor: 'rgba(91,140,255,0.15)',
        pointBackgroundColor: '#5b8cff',
        pointRadius: 4,
        tension: 0.25,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#9aa2b1', maxRotation: 0, autoSkip: true }, grid: { color: '#2a2f3a' } },
        y: { ticks: { color: '#9aa2b1' }, grid: { color: '#2a2f3a' }, beginAtZero: true },
      },
    },
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
syncLayoutVars();
setView('log');
if (activeWorkout) startTimerInterval();

/* ---------- Service worker registration ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
