import { initMidi, midiNoteToName } from "./midi.js";
import { NoteMatcher, getStaffPositionForNote, getNotePixelPosition } from "./matching.js";
import {
  putFileContent,
  getFileContent,
  getAllFileContents,
  deleteFileContent,
  putProgress,
  getProgress,
  getAllProgress,
  deleteProgress,
} from "./db.js";
import { renderLibraryList, readUploadedFile } from "./library.js";

const SAMPLE_FILE_URL = "samples/sample-grand-staff.musicxml";
const SAMPLE_FILE_NAME = "Sample Grand Staff Exercise.musicxml";
const MAX_LOG_ENTRIES = 100;
const STAFF_LABELS = { 1: "Right hand", 2: "Left hand" };
const WRONG_NOTEHEAD_COLOR = "#CC0000";
const CORRECT_NOTEHEAD_COLOR = "#1A7F37";
const INACTIVE_HAND_COLOR = "#BBBBBB";
const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_PIECE_WALK_STEPS = 50_000; // safety cap against a runaway loop on a malformed file

let matcher = null;
let osmdInstance = null;
let currentEntry = null;
let heldNoteMarkers = new Map(); // midi -> isCorrect, for notes currently held down

const libraryView = document.getElementById("library-view");
const practiceView = document.getElementById("practice-view");
const libraryList = document.getElementById("library-list");
const fileUpload = document.getElementById("file-upload");
const uploadError = document.getElementById("upload-error");
const octaveStrictToggle = document.getElementById("octave-strict-toggle");
const handModeButtons = Array.from(document.querySelectorAll(".hand-mode-button"));

function showLibraryView() {
  matcher = null;
  osmdInstance = null;
  currentEntry = null;
  practiceView.hidden = true;
  libraryView.hidden = false;
  refreshLibraryList();
}

function showPracticeView() {
  libraryView.hidden = true;
  practiceView.hidden = false;
}

const DEFAULT_SETTINGS = { octaveStrict: true, handMode: "both" };
const DEFAULT_PROGRESS = { stepIndex: 0, completed: false };

function setHandModeButtonsActive(mode) {
  for (const button of handModeButtons) {
    button.classList.toggle("active", button.dataset.handMode === mode);
  }
}

async function getLibraryEntries() {
  const [files, progressRecords] = await Promise.all([getAllFileContents(), getAllProgress()]);
  const progressById = new Map(progressRecords.map((p) => [p.id, p]));
  return files.map((file) => {
    const p = progressById.get(file.id);
    return {
      id: file.id,
      fileName: file.fileName,
      settings: p?.settings ?? DEFAULT_SETTINGS,
      progress: p?.progress ?? DEFAULT_PROGRESS,
      updatedAt: p?.updatedAt ?? file.createdAt,
    };
  });
}

async function refreshLibraryList() {
  const entries = await getLibraryEntries();
  renderLibraryList(libraryList, entries, {
    onOpen: openPiece,
    onDelete: async (id) => {
      await Promise.all([deleteFileContent(id), deleteProgress(id)]);
      refreshLibraryList();
    },
  });
}

// Only the small { id, settings, progress, updatedAt } record is written here —
// never the file's MusicXML text, which can be several MB. IndexedDB has no
// partial-update API, so including it would mean re-serializing and rewriting
// the whole score on every single note advance (this was the actual cause of
// multi-second per-keystroke lag on real pieces).
function saveCurrentEntry() {
  if (!currentEntry) return;
  currentEntry.updatedAt = Date.now();
  putProgress({
    id: currentEntry.id,
    settings: currentEntry.settings,
    progress: currentEntry.progress,
    updatedAt: currentEntry.updatedAt,
  }).catch((err) => console.error("Failed to save progress:", err));
}

function renderExpectedNotes(expected) {
  const el = document.getElementById("expected-notes");
  const byStaff = new Map();
  for (const n of expected) {
    if (!byStaff.has(n.staffId)) byStaff.set(n.staffId, []);
    byStaff.get(n.staffId).push(midiNoteToName(n.midi));
  }
  const parts = Array.from(byStaff.entries()).map(
    ([staffId, names]) => `${STAFF_LABELS[staffId] ?? `Staff ${staffId}`}: ${names.join(" + ")}`
  );
  el.textContent = `Waiting for — ${parts.join("   |   ")}`;
  el.classList.remove("complete");

  if (currentEntry) {
    currentEntry.progress.stepIndex = matcher.totalAdvances;
    currentEntry.progress.completed = false;
    saveCurrentEntry();
  }
}

function renderComplete() {
  const el = document.getElementById("expected-notes");
  el.textContent = "Piece complete!";
  el.classList.add("complete");

  if (currentEntry) {
    currentEntry.progress.stepIndex = matcher.totalAdvances;
    currentEntry.progress.completed = true;
    saveCurrentEntry();
  }
}

function trackPlayedNote(midi, isCorrect) {
  heldNoteMarkers.set(midi, isCorrect);
}

function makeMarker(className, x, y, { filled, color }) {
  const marker = document.createElementNS(SVG_NS, "ellipse");
  marker.setAttribute("cx", x);
  marker.setAttribute("cy", y);
  marker.setAttribute("rx", filled ? "5.5" : "7");
  marker.setAttribute("ry", filled ? "4.5" : "6");
  marker.setAttribute("class", className);
  if (filled) {
    marker.setAttribute("fill", color);
    marker.setAttribute("fill-opacity", "0.7");
    marker.setAttribute("stroke", "#ffffff");
    marker.setAttribute("stroke-width", "1");
  } else {
    marker.setAttribute("fill", "none");
    marker.setAttribute("stroke", color);
    marker.setAttribute("stroke-width", "2.5");
  }
  return marker;
}

// Both marker layers are plain SVG overlay elements added/removed directly —
// never through osmd.render(), which re-lays-out and redraws the *entire*
// score. That's fine for a few measures but takes seconds on a real piece,
// so per-keystroke feedback must never trigger it.
function redrawPlayedNoteMarkers() {
  const svg = document.querySelector("#osmd-container svg");
  if (!svg) return;

  svg.querySelectorAll(".played-note-marker").forEach((el) => el.remove());
  if (!matcher) return;

  for (const [midi, isCorrect] of heldNoteMarkers) {
    const pos = getStaffPositionForNote(osmdInstance, matcher.expected, midi);
    if (!pos) continue;
    svg.appendChild(
      makeMarker("played-note-marker", pos.x, pos.y, {
        filled: true,
        color: isCorrect ? CORRECT_NOTEHEAD_COLOR : WRONG_NOTEHEAD_COLOR,
      })
    );
  }
}

// Target notes only ever highlight green (notes of the current chord you've
// already correctly held). They never turn red on a wrong note — that would
// make it look like the target itself was wrong, when it's actually whatever
// you just played that's wrong. That's what the played-note marker is for.
function redrawTargetNoteMarkers(correctSoFar) {
  const svg = document.querySelector("#osmd-container svg");
  if (!svg) return;

  svg.querySelectorAll(".target-note-marker").forEach((el) => el.remove());
  if (!matcher) return;

  for (const entry of correctSoFar) {
    const pos = getNotePixelPosition(osmdInstance, entry.note);
    if (!pos) continue;
    svg.appendChild(makeMarker("target-note-marker", pos.x, pos.y, { filled: false, color: CORRECT_NOTEHEAD_COLOR }));
  }
}

function applyFeedbackVisuals({ correctSoFar }) {
  redrawTargetNoteMarkers(correctSoFar);
  redrawPlayedNoteMarkers();
}

// Notes split by staff, cached once per piece load so switching hand mode
// doesn't have to re-walk the whole piece via the cursor every time (which,
// combined with the followCursor scroll checks on every cursor.next() call,
// made hand-mode switching take seconds on a large real piece).
let rightHandNotes = [];
let leftHandNotes = [];

function buildHandNoteCache(osmd) {
  rightHandNotes = [];
  leftHandNotes = [];

  osmd.cursor.hide(); // avoid per-step scroll/visual-update overhead while walking
  osmd.cursor.reset();
  let steps = 0;
  while (!osmd.cursor.iterator.EndReached && steps < MAX_PIECE_WALK_STEPS) {
    for (const note of osmd.cursor.NotesUnderCursor()) {
      if (note.isRest()) continue;
      const staffId = note.ParentStaffEntry.ParentStaff.Id;
      if (staffId === 1) rightHandNotes.push(note);
      else if (staffId === 2) leftHandNotes.push(note);
    }
    osmd.cursor.next();
    steps++;
  }
  osmd.cursor.reset();
}

// Colors the deselected hand's notes grey using the cache above — no walking,
// so the only real cost left is the render() call itself, which is still
// fine here since hand-mode switching is a rare, deliberate action, unlike
// the per-keystroke feedback path.
function applyHandModeGreyOut(handMode) {
  if (!osmdInstance || !matcher) return;
  for (const note of rightHandNotes) {
    note.NoteheadColor = handMode === "left" ? INACTIVE_HAND_COLOR : undefined;
  }
  for (const note of leftHandNotes) {
    note.NoteheadColor = handMode === "right" ? INACTIVE_HAND_COLOR : undefined;
  }
  osmdInstance.render();
  osmdInstance.cursor.show();

  // render() just wiped our SVG overlay markers; redraw them for the current
  // position (re-applying the same hand mode is a cheap way to force that).
  matcher.setHandMode(matcher.handMode);
}

async function openPiece(id) {
  const [fileContent, progressRecord] = await Promise.all([getFileContent(id), getProgress(id)]);
  if (!fileContent) return;

  // Merge over defaults (not just fall back to them) so settings added after a
  // file was first saved — like hand mode — still get a sane value.
  const settings = { ...DEFAULT_SETTINGS, ...progressRecord?.settings };
  const progress = { ...DEFAULT_PROGRESS, ...progressRecord?.progress };
  currentEntry = { id, fileName: fileContent.fileName, settings, progress };

  showPracticeView();
  document.getElementById("practice-title").textContent = fileContent.fileName;

  const container = document.getElementById("osmd-container");
  container.innerHTML = "";
  document.getElementById("expected-notes").textContent = "Loading score…";

  heldNoteMarkers = new Map();

  try {
    const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(container, {
      autoResize: true,
      drawTitle: true,
      followCursor: true,
      cursorsOptions: [{ type: opensheetmusicdisplay.CursorType.Standard, color: "#3B82F6", alpha: 0.25, follow: true }],
    });
    osmdInstance = osmd;

    await osmd.load(fileContent.musicXmlText);
    osmd.render();
    buildHandNoteCache(osmd);

    octaveStrictToggle.checked = currentEntry.settings.octaveStrict;
    setHandModeButtonsActive(currentEntry.settings.handMode);

    matcher = new NoteMatcher(osmd, {
      octaveStrict: currentEntry.settings.octaveStrict,
      handMode: currentEntry.settings.handMode,
    });
    matcher.onAdvance = renderExpectedNotes;
    matcher.onComplete = renderComplete;
    matcher.onFeedbackChange = applyFeedbackVisuals;
    matcher.onNotePlayed = trackPlayedNote;
    matcher.start(currentEntry.progress.stepIndex || 0);
    // Skip the extra render for the common default case (nothing to grey out).
    if (currentEntry.settings.handMode !== "both") {
      applyHandModeGreyOut(currentEntry.settings.handMode);
    }
  } catch (err) {
    console.error("Failed to load piece:", err);
    container.textContent = "Failed to load this piece. The file may be corrupted or not valid MusicXML.";
  }
}

octaveStrictToggle.addEventListener("change", () => {
  if (!matcher) return;
  matcher.setOctaveStrict(octaveStrictToggle.checked);
  if (currentEntry) {
    currentEntry.settings.octaveStrict = octaveStrictToggle.checked;
    saveCurrentEntry();
  }
});

for (const button of handModeButtons) {
  button.addEventListener("click", () => {
    if (!matcher) return;
    const mode = button.dataset.handMode;
    matcher.setHandMode(mode);
    setHandModeButtonsActive(mode);
    applyHandModeGreyOut(mode);
    if (currentEntry) {
      currentEntry.settings.handMode = mode;
      saveCurrentEntry();
    }
  });
}

document.getElementById("back-to-library").addEventListener("click", showLibraryView);

fileUpload.addEventListener("change", async () => {
  const file = fileUpload.files[0];
  if (!file) return;

  uploadError.hidden = true;

  try {
    const musicXmlText = await readUploadedFile(file);
    const id = crypto.randomUUID();
    const now = Date.now();
    await Promise.all([
      putFileContent({ id, fileName: file.name, musicXmlText, createdAt: now }),
      putProgress({ id, settings: { ...DEFAULT_SETTINGS }, progress: { ...DEFAULT_PROGRESS }, updatedAt: now }),
    ]);
    fileUpload.value = "";
    openPiece(id);
  } catch (err) {
    console.error("Failed to read uploaded file:", err);
    uploadError.textContent = `Couldn't read "${file.name}": ${err.message}`;
    uploadError.hidden = false;
    fileUpload.value = "";
  }
});

async function initLibrary() {
  const files = await getAllFileContents();
  if (files.length === 0) {
    const response = await fetch(SAMPLE_FILE_URL);
    const musicXmlText = await response.text();
    const id = crypto.randomUUID();
    const now = Date.now();
    await Promise.all([
      putFileContent({ id, fileName: SAMPLE_FILE_NAME, musicXmlText, createdAt: now }),
      putProgress({ id, settings: { ...DEFAULT_SETTINGS }, progress: { ...DEFAULT_PROGRESS }, updatedAt: now }),
    ]);
  }
  await refreshLibraryList();
}

initLibrary().catch((err) => {
  console.error("Failed to initialize library:", err);
  libraryList.textContent = "Failed to load your library. See console for details.";
});

function setMidiStatus({ ok, message }) {
  const statusEl = document.getElementById("midi-status");
  statusEl.textContent = message;
  statusEl.classList.toggle("ok", ok);
  statusEl.classList.toggle("error", !ok);
}

function logMidiEvent(event) {
  console.log(`MIDI ${event.type}: ${event.name} (note ${event.note}, velocity ${event.velocity})`);

  const logEl = document.getElementById("midi-log");
  const entry = document.createElement("li");
  entry.className = event.type === "on" ? "note-on" : "note-off";
  const timestamp = new Date().toLocaleTimeString();
  entry.textContent = `[${timestamp}] note ${event.type === "on" ? "ON " : "OFF"} — ${event.name} (${event.note}), velocity ${event.velocity}`;
  logEl.prepend(entry);

  while (logEl.children.length > MAX_LOG_ENTRIES) {
    logEl.removeChild(logEl.lastChild);
  }

  if (matcher) {
    if (event.type === "on") {
      matcher.noteOn(event.note);
    } else {
      heldNoteMarkers.delete(event.note);
      matcher.noteOff(event.note);
    }
  }
}

initMidi(logMidiEvent, setMidiStatus);
