// Cache-busting query param on every internal import: GitHub Pages' default
// cache lifetime, combined with browsers not always revalidating on a plain
// reload, has repeatedly served stale JS after a deploy in testing. Bump
// this string (e.g. to today's date) whenever you deploy a real change.
import { initMidi, midiNoteToName } from "./midi.js?v=20260718-1";
import {
  NoteMatcher,
  getStaffPositionForNote,
  getNotePixelPosition,
  walkPiece,
  extractPlaybackNotes,
} from "./matching.js?v=20260718-1";
import { Player } from "./playback.js?v=20260718-1";
import {
  putFileContent,
  getFileContent,
  getAllFileContents,
  deleteFileContent,
  putProgress,
  getProgress,
  getAllProgress,
  deleteProgress,
} from "./db.js?v=20260718-1";
import { renderLibraryList, readUploadedFile } from "./library.js?v=20260718-1";

const SAMPLE_FILE_URL = "samples/sample-grand-staff.musicxml";
const SAMPLE_FILE_NAME = "Sample Grand Staff Exercise.musicxml";
const MAX_LOG_ENTRIES = 100;
const STAFF_LABELS = { 1: "Right hand", 2: "Left hand" };
const WRONG_NOTEHEAD_COLOR = "#CC0000";
const CORRECT_NOTEHEAD_COLOR = "#1A7F37";
const INACTIVE_HAND_COLOR = "#BBBBBB";
const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_BPM = 100;

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
const selectSectionButton = document.getElementById("select-section-button");
const exitSectionButton = document.getElementById("exit-section-button");
const sectionInstructions = document.getElementById("section-instructions");
const osmdContainer = document.getElementById("osmd-container");
const playButton = document.getElementById("play-button");

const player = new Player();

// Section-practice click-to-select state. `sectionSelectionState` is null
// (idle), "awaiting-start", or "awaiting-end". `preSectionPosition` is the
// in-session step to return to on exit — separate from the persisted
// progress, since dipping into section practice shouldn't affect it.
let sectionSelectionState = null;
let sectionStartStep = null;
let preSectionPosition = 0;

// Every note in the piece with its cursor step, staff, and pixel position —
// built once per piece load. Used for hand/section grey-out and for mapping
// a click to the nearest note (general click-to-jump navigation during
// normal practice; section-boundary picking uses measureZones instead, so
// clicking near a barline works as well as clicking a specific note).
let pieceNoteCache = [];
let measureZones = [];

function showLibraryView() {
  player.stop();
  updatePlayButtonLabel();
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

  // Section practice loops independently of the piece's overall saved
  // position — don't let a loop overwrite where the user last resumed to.
  if (currentEntry && matcher.sectionEnd == null) {
    currentEntry.progress.stepIndex = matcher.totalAdvances;
    currentEntry.progress.completed = false;
    saveCurrentEntry();
  }
}

function renderComplete() {
  const el = document.getElementById("expected-notes");
  el.textContent = "Piece complete!";
  el.classList.add("complete");

  if (currentEntry && matcher.sectionEnd == null) {
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

// Built once per piece load (see openPiece), always right after a fresh
// osmd.load()+render() and before the new matcher exists — so there's never
// a prior position to restore here (that stale reasoning caused a real bug:
// this used to fall back to a leftover matcher from a *previously* opened
// piece, whose totalAdvances could exceed this piece's step count entirely).
function buildPieceNoteCache(osmd) {
  const cache = [];
  walkPiece(osmd, (stepIndex, notes) => {
    for (const note of notes) {
      const pos = getNotePixelPosition(osmd, note);
      cache.push({
        note,
        stepIndex,
        staffId: note.ParentStaffEntry.ParentStaff.Id,
        measureNumber: note.SourceMeasure.MeasureNumber,
        x: pos?.x ?? null,
        y: pos?.y ?? null,
      });
    }
  });
  return cache;
}

// One zone per measure (first/last step, horizontal center, vertical position),
// derived from the note cache. Section-boundary clicks snap to whichever
// measure they're nearest to rather than requiring a pixel-precise note hit —
// this is what lets clicking near a barline work as well as clicking a note,
// and incidentally makes it much harder to accidentally select a near-empty
// section from an imprecise click.
function buildMeasureZones(cache) {
  const byMeasure = new Map();
  for (const entry of cache) {
    if (entry.x == null || entry.y == null) continue;
    let zone = byMeasure.get(entry.measureNumber);
    if (!zone) {
      zone = { firstStep: entry.stepIndex, lastStep: entry.stepIndex, minX: entry.x, maxX: entry.x, y: entry.y };
      byMeasure.set(entry.measureNumber, zone);
    }
    zone.firstStep = Math.min(zone.firstStep, entry.stepIndex);
    zone.lastStep = Math.max(zone.lastStep, entry.stepIndex);
    zone.minX = Math.min(zone.minX, entry.x);
    zone.maxX = Math.max(zone.maxX, entry.x);
  }
  return Array.from(byMeasure.values());
}

function findNearestMeasureZone(zones, x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const zone of zones) {
    const centerX = (zone.minX + zone.maxX) / 2;
    const dist = (centerX - x) ** 2 + (zone.y - y) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = zone;
    }
  }
  return best;
}

// Greys out notes that are either the deselected hand or outside the active
// practice section (both conditions checked together, since either one can
// apply at once). No walking — just recolors from the cache — so the only
// real cost is the render() call itself, which is fine here since this only
// runs on a deliberate hand-mode/section change, never per keystroke.
function applyGreyOut() {
  if (!osmdInstance || !matcher) return;
  const { handMode, sectionStart, sectionEnd } = matcher;

  for (const entry of pieceNoteCache) {
    const handOk =
      handMode === "both" || (handMode === "right" && entry.staffId === 1) || (handMode === "left" && entry.staffId === 2);
    const sectionOk = sectionStart == null || (entry.stepIndex >= sectionStart && entry.stepIndex <= sectionEnd);
    entry.note.NoteheadColor = handOk && sectionOk ? undefined : INACTIVE_HAND_COLOR;
  }
  osmdInstance.render();
  osmdInstance.cursor.show();

  // render() just wiped our SVG overlay markers; redraw them for the current
  // position (re-applying the same hand mode is a cheap way to force that).
  matcher.setHandMode(matcher.handMode);
}

function findNearestStep(cache, x, y) {
  let bestStep = null;
  let bestDist = Infinity;
  for (const entry of cache) {
    if (entry.x == null || entry.y == null) continue;
    const dist = (entry.x - x) ** 2 + (entry.y - y) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestStep = entry.stepIndex;
    }
  }
  return bestStep;
}

function screenToSvgPoint(svg, clientX, clientY) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const svgPt = pt.matrixTransform(ctm.inverse());
  return { x: svgPt.x, y: svgPt.y };
}

function setSectionInstructions(text) {
  sectionInstructions.textContent = text;
  sectionInstructions.hidden = !text;
}

function beginSectionSelection() {
  if (!matcher || matcher.sectionEnd != null) return;
  sectionSelectionState = "awaiting-start";
  sectionStartStep = null;
  osmdContainer.classList.add("selecting-section");
  selectSectionButton.textContent = "Cancel selection";
  selectSectionButton.classList.add("selecting");
  setSectionInstructions("Click a note or measure to set the section start.");
}

function cancelSectionSelection() {
  sectionSelectionState = null;
  sectionStartStep = null;
  osmdContainer.classList.remove("selecting-section");
  selectSectionButton.textContent = "Practice a section…";
  selectSectionButton.classList.remove("selecting");
  setSectionInstructions("");
}

function measureNumberForStep(step) {
  const entry = pieceNoteCache.find((e) => e.stepIndex === step);
  return entry ? entry.measureNumber : null;
}

function startSectionPractice(startStep, endStep) {
  preSectionPosition = matcher.totalAdvances;
  heldNoteMarkers = new Map();
  matcher.startSection(startStep, endStep);
  applyGreyOut();

  osmdContainer.classList.remove("selecting-section");
  selectSectionButton.hidden = true;
  exitSectionButton.hidden = false;

  const startMeasure = measureNumberForStep(startStep);
  const endMeasure = measureNumberForStep(endStep);
  const range =
    startMeasure != null && endMeasure != null
      ? startMeasure === endMeasure
        ? `measure ${startMeasure}`
        : `measures ${startMeasure}–${endMeasure}`
      : "selected range";
  setSectionInstructions(`Practicing ${range} on a loop.`);
}

function exitSectionPractice() {
  if (!matcher) return;
  matcher.stopSection();
  heldNoteMarkers = new Map();
  matcher.start(preSectionPosition);
  applyGreyOut(); // un-grey the rest of the piece (unless a single hand is also selected)

  selectSectionButton.hidden = false;
  exitSectionButton.hidden = true;
  setSectionInstructions("");
}

selectSectionButton.addEventListener("click", () => {
  if (sectionSelectionState) {
    cancelSectionSelection();
  } else {
    beginSectionSelection();
  }
});

exitSectionButton.addEventListener("click", exitSectionPractice);

function updatePlayButtonLabel() {
  playButton.textContent = player.isPlaying ? "⏹ Stop" : "▶ Play";
}

// Previews the current scope (the active section if one is looping,
// otherwise the whole piece) as audio, so the user can hear how it's meant
// to sound before playing along. Doesn't move the practice cursor.
playButton.addEventListener("click", () => {
  if (!matcher || !osmdInstance) return;

  if (player.isPlaying) {
    player.stop();
    updatePlayButtonLabel();
    return;
  }

  const startStep = matcher.sectionStart ?? 0;
  const endStep = matcher.sectionEnd ?? null;
  const bpm = osmdInstance.Sheet?.DefaultStartTempoInBpm || DEFAULT_BPM;
  const notes = extractPlaybackNotes(osmdInstance, startStep, endStep, bpm, matcher.totalAdvances);
  player.play(notes, { onEnd: updatePlayButtonLabel });
  updatePlayButtonLabel();
});

// Click-to-navigate: while picking a section, sets its start/end (snapping
// to the nearest whole measure, so clicking near a barline works as well as
// clicking directly on a note). Otherwise, during normal full-piece
// practice, jumps the cursor straight to whatever note was clicked. Disabled
// while a section loop is actively running — exit it first (no obvious
// "still respect the loop" behavior for a click).
osmdContainer.addEventListener("click", (event) => {
  if (!matcher) return;
  const svg = osmdContainer.querySelector("svg");
  if (!svg) return;

  const pt = screenToSvgPoint(svg, event.clientX, event.clientY);
  if (!pt) return;

  if (sectionSelectionState === "awaiting-start") {
    const zone = findNearestMeasureZone(measureZones, pt.x, pt.y);
    if (!zone) return;
    sectionStartStep = zone.firstStep;
    sectionSelectionState = "awaiting-end";
    setSectionInstructions("Click a measure to set the section end.");
    return;
  }
  if (sectionSelectionState === "awaiting-end") {
    const zone = findNearestMeasureZone(measureZones, pt.x, pt.y);
    if (!zone) return;
    const start = Math.min(sectionStartStep, zone.firstStep);
    const end = Math.max(sectionStartStep, zone.lastStep);
    sectionSelectionState = null;
    startSectionPractice(start, end);
    return;
  }
  if (matcher.sectionEnd != null) return;

  const stepIndex = findNearestStep(pieceNoteCache, pt.x, pt.y);
  if (stepIndex == null) return;
  heldNoteMarkers = new Map();
  matcher.start(stepIndex);
});

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
  cancelSectionSelection();
  preSectionPosition = 0;
  selectSectionButton.hidden = false;
  exitSectionButton.hidden = true;
  player.stop();
  updatePlayButtonLabel();

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
    pieceNoteCache = buildPieceNoteCache(osmd);
    measureZones = buildMeasureZones(pieceNoteCache);

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
    // Always start at the beginning when a piece is opened — saved progress
    // is still tracked (shown in the library) but isn't used to auto-resume.
    matcher.start(0);
    // Skip the extra render for the common default case (nothing to grey out).
    if (currentEntry.settings.handMode !== "both") {
      applyGreyOut();
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
    applyGreyOut();
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
