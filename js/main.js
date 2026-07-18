import { initMidi, midiNoteToName } from "./midi.js";
import { NoteMatcher, getStaffPositionForNote, getNotePixelPosition } from "./matching.js";
import { getAllFiles, getFile, putFile, deleteFile } from "./db.js";
import { renderLibraryList, readUploadedFile } from "./library.js";

const SAMPLE_FILE_URL = "samples/sample-grand-staff.musicxml";
const SAMPLE_FILE_NAME = "Sample Grand Staff Exercise.musicxml";
const MAX_LOG_ENTRIES = 100;
const STAFF_LABELS = { 1: "Right hand", 2: "Left hand" };
const WRONG_NOTEHEAD_COLOR = "#CC0000";
const CORRECT_NOTEHEAD_COLOR = "#1A7F37";
const SVG_NS = "http://www.w3.org/2000/svg";

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

async function refreshLibraryList() {
  const entries = await getAllFiles();
  renderLibraryList(libraryList, entries, {
    onOpen: openPiece,
    onDelete: async (id) => {
      await deleteFile(id);
      refreshLibraryList();
    },
  });
}

function saveCurrentEntry() {
  if (!currentEntry) return;
  currentEntry.updatedAt = Date.now();
  putFile(currentEntry).catch((err) => console.error("Failed to save progress:", err));
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

function redrawTargetNoteMarkers(wrong, correctSoFar) {
  const svg = document.querySelector("#osmd-container svg");
  if (!svg) return;

  svg.querySelectorAll(".target-note-marker").forEach((el) => el.remove());
  if (!matcher) return;

  const isWrong = wrong.length > 0;
  const entries = isWrong ? matcher.expected : correctSoFar;
  const color = isWrong ? WRONG_NOTEHEAD_COLOR : CORRECT_NOTEHEAD_COLOR;

  for (const entry of entries) {
    const pos = getNotePixelPosition(osmdInstance, entry.note);
    if (!pos) continue;
    svg.appendChild(makeMarker("target-note-marker", pos.x, pos.y, { filled: false, color }));
  }
}

function applyFeedbackVisuals({ wrong, correctSoFar }) {
  redrawTargetNoteMarkers(wrong, correctSoFar);
  redrawPlayedNoteMarkers();
}

async function openPiece(id) {
  const entry = await getFile(id);
  if (!entry) return;

  currentEntry = entry;
  showPracticeView();
  document.getElementById("practice-title").textContent = entry.fileName;

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

    await osmd.load(entry.musicXmlText);
    osmd.render();

    octaveStrictToggle.checked = entry.settings.octaveStrict;

    matcher = new NoteMatcher(osmd, { octaveStrict: entry.settings.octaveStrict });
    matcher.onAdvance = renderExpectedNotes;
    matcher.onComplete = renderComplete;
    matcher.onFeedbackChange = applyFeedbackVisuals;
    matcher.onNotePlayed = trackPlayedNote;
    matcher.start(entry.progress.stepIndex || 0);
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

document.getElementById("back-to-library").addEventListener("click", showLibraryView);

fileUpload.addEventListener("change", async () => {
  const file = fileUpload.files[0];
  if (!file) return;

  uploadError.hidden = true;

  try {
    const musicXmlText = await readUploadedFile(file);
    const entry = {
      id: crypto.randomUUID(),
      fileName: file.name,
      musicXmlText,
      settings: { octaveStrict: true },
      progress: { stepIndex: 0, completed: false },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await putFile(entry);
    fileUpload.value = "";
    openPiece(entry.id);
  } catch (err) {
    console.error("Failed to read uploaded file:", err);
    uploadError.textContent = `Couldn't read "${file.name}": ${err.message}`;
    uploadError.hidden = false;
    fileUpload.value = "";
  }
});

async function initLibrary() {
  const entries = await getAllFiles();
  if (entries.length === 0) {
    const response = await fetch(SAMPLE_FILE_URL);
    const musicXmlText = await response.text();
    await putFile({
      id: crypto.randomUUID(),
      fileName: SAMPLE_FILE_NAME,
      musicXmlText,
      settings: { octaveStrict: true },
      progress: { stepIndex: 0, completed: false },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
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
