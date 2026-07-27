// Cache-busting query param on every internal import: GitHub Pages' default
// cache lifetime, combined with browsers not always revalidating on a plain
// reload, has repeatedly served stale JS after a deploy in testing. Bump
// this string (e.g. to today's date) whenever you deploy a real change.
import { initMidi, midiNoteToName } from "./midi.js?v=20260718-4";
import {
  NoteMatcher,
  getStaffPositionForNote,
  getNotePixelPosition,
  walkPiece,
  extractPlaybackNotes,
} from "./matching.js?v=20260718-4";
import { Player } from "./playback.js?v=20260718-4";
import {
  putFileContent,
  getFileContent,
  getAllFileContents,
  deleteFileContent,
  putProgress,
  getProgress,
  getAllProgress,
  deleteProgress,
} from "./db.js?v=20260718-4";
import { renderLibraryList, readUploadedFile } from "./library.js?v=20260718-4";

const SAMPLE_FILE_URL = "samples/sample-grand-staff.musicxml";
const SAMPLE_FILE_NAME = "Sample Grand Staff Exercise.musicxml";
const MAX_LOG_ENTRIES = 100;
const STAFF_LABELS = { 1: "Right hand", 2: "Left hand" };
const WRONG_NOTEHEAD_COLOR = "#CC0000";
const CORRECT_NOTEHEAD_COLOR = "#1A7F37";
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
const saveSectionButton = document.getElementById("save-section-button");
const savedSectionsList = document.getElementById("saved-sections-list");
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
let measureSystems = []; // measureZones grouped by line, for multi-line range highlighting

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
// A function, not a shared object constant: savedSections is an array, and a
// shared default would mean every piece's "empty" progress pushes into the
// *same* array reference the moment one piece saves a section.
function defaultProgress() {
  return { stepIndex: 0, completed: false, savedSections: [] };
}

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
      progress: p?.progress ?? defaultProgress(),
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

const SYSTEM_Y_CLUSTER_THRESHOLD = 50; // px; groups measures on the same line together

// One zone per measure (step range, X extent, average Y), derived from the
// note cache. Section-boundary clicks snap to whichever measure they land
// in rather than requiring a pixel-precise note hit — this is what lets
// clicking near a barline work as well as clicking a note, and incidentally
// makes it much harder to accidentally select a near-empty section from an
// imprecise click. Each zone's clickable X range is bounded by the *gaps* to
// its neighbors on the same line (not by nearest-center distance) so the
// decision boundary sits at the actual barline, not skewed toward whichever
// neighboring measure happens to have a wider spread of notes.
function buildMeasureZones(cache) {
  const byMeasure = new Map();
  for (const entry of cache) {
    if (entry.x == null || entry.y == null) continue;
    let zone = byMeasure.get(entry.measureNumber);
    if (!zone) {
      zone = {
        measureNumber: entry.measureNumber,
        firstStep: entry.stepIndex,
        lastStep: entry.stepIndex,
        minX: entry.x,
        maxX: entry.x,
        minY: entry.y,
        maxY: entry.y,
        ySum: 0,
        yCount: 0,
      };
      byMeasure.set(entry.measureNumber, zone);
    }
    zone.firstStep = Math.min(zone.firstStep, entry.stepIndex);
    zone.lastStep = Math.max(zone.lastStep, entry.stepIndex);
    zone.minX = Math.min(zone.minX, entry.x);
    zone.maxX = Math.max(zone.maxX, entry.x);
    zone.minY = Math.min(zone.minY, entry.y);
    zone.maxY = Math.max(zone.maxY, entry.y);
    zone.ySum += entry.y;
    zone.yCount += 1;
  }
  const zones = Array.from(byMeasure.values()).map((z) => ({ ...z, y: z.ySum / z.yCount }));

  const rawSystems = [];
  for (const zone of zones.sort((a, b) => a.firstStep - b.firstStep)) {
    const system = rawSystems.find((s) => Math.abs(s[0].y - zone.y) < SYSTEM_Y_CLUSTER_THRESHOLD);
    if (system) system.push(zone);
    else rawSystems.push([zone]);
  }

  // Systems (lines), top to bottom, each with its own bounds — needed to draw
  // a live selection-range highlight that spans multiple lines correctly
  // (one rect per line the range touches, not one rect covering everything
  // in between, which would paint over unrelated staff area), and to grey
  // out one staff (hand) across a whole line independent of section bounds.
  const systems = rawSystems
    .sort((a, b) => a[0].y - b[0].y)
    .map((zonesInSystem) => {
      zonesInSystem.sort((a, b) => a.minX - b.minX);
      zonesInSystem.forEach((zone, i) => {
        const prev = zonesInSystem[i - 1];
        const next = zonesInSystem[i + 1];
        zone.leftBound = prev ? (prev.maxX + zone.minX) / 2 : -Infinity;
        zone.rightBound = next ? (zone.maxX + next.minX) / 2 : Infinity;
      });

      const measureNumbersInSystem = new Set(zonesInSystem.map((z) => z.measureNumber));
      const staffBands = {};
      for (const entry of cache) {
        if (entry.y == null || !measureNumbersInSystem.has(entry.measureNumber)) continue;
        const band = staffBands[entry.staffId] ?? { minY: entry.y, maxY: entry.y };
        band.minY = Math.min(band.minY, entry.y);
        band.maxY = Math.max(band.maxY, entry.y);
        staffBands[entry.staffId] = band;
      }

      return {
        zones: zonesInSystem,
        minY: Math.min(...zonesInSystem.map((z) => z.minY)),
        maxY: Math.max(...zonesInSystem.map((z) => z.maxY)),
        staffBands,
      };
    });

  return { zones, systems };
}

function findNearestMeasureZone(zones, x, y) {
  if (zones.length === 0) return null;

  let nearestY = zones[0].y;
  let bestYDist = Infinity;
  for (const zone of zones) {
    const dist = Math.abs(zone.y - y);
    if (dist < bestYDist) {
      bestYDist = dist;
      nearestY = zone.y;
    }
  }
  const onThisLine = zones.filter((z) => Math.abs(z.y - nearestY) < SYSTEM_Y_CLUSTER_THRESHOLD);

  const containing = onThisLine.find((z) => x >= z.leftBound && x < z.rightBound);
  if (containing) return containing;

  // Fallback (shouldn't normally hit, since bounds are -Infinity..Infinity
  // at the ends of each line): nearest center on the same line.
  let best = null;
  let bestDist = Infinity;
  for (const zone of onThisLine) {
    const dist = Math.abs((zone.minX + zone.maxX) / 2 - x);
    if (dist < bestDist) {
      bestDist = dist;
      best = zone;
    }
  }
  return best;
}

const INACTIVE_OVERLAY_PADDING = 25; // px above/below a staff band's actual note extent
const INACTIVE_OVERLAY_OPACITY = 0.65;

// Greys out whichever staff/measure combinations are either the deselected
// hand or outside the active practice section (both conditions checked
// together, since either can apply at once — right-hand-only *and* a
// section both grey out the left hand entirely and everything horizontally
// outside the section). Draws a semi-opaque white wash over the whole cell
// (notehead, stem, beams, and the staff lines underneath) rather than
// recoloring individual note elements, which only ever affected noteheads —
// stems/staff lines stayed black. This also means no osmd.render() call is
// needed here at all, unlike the old notehead-recoloring approach: switching
// hand mode or a section is now instant regardless of piece size.
function redrawInactiveOverlay() {
  const svg = osmdContainer.querySelector("svg");
  if (!svg || !matcher) return;
  svg.querySelectorAll(".inactive-overlay").forEach((el) => el.remove());

  const { handMode, sectionStart, sectionEnd } = matcher;

  for (const system of measureSystems) {
    for (const [staffIdStr, band] of Object.entries(system.staffBands)) {
      const staffId = Number(staffIdStr);
      const handOk = handMode === "both" || (handMode === "right" && staffId === 1) || (handMode === "left" && staffId === 2);

      for (const zone of system.zones) {
        const sectionOk = sectionStart == null || (zone.lastStep >= sectionStart && zone.firstStep <= sectionEnd);
        if (handOk && sectionOk) continue;

        const left = zone.leftBound === -Infinity ? zone.minX - INACTIVE_OVERLAY_PADDING : zone.leftBound;
        const right = zone.rightBound === Infinity ? zone.maxX + INACTIVE_OVERLAY_PADDING : zone.rightBound;
        const rect = document.createElementNS(SVG_NS, "rect");
        rect.setAttribute("x", left);
        rect.setAttribute("width", right - left);
        rect.setAttribute("y", band.minY - INACTIVE_OVERLAY_PADDING);
        rect.setAttribute("height", band.maxY - band.minY + INACTIVE_OVERLAY_PADDING * 2);
        rect.setAttribute("fill", "#ffffff");
        rect.setAttribute("fill-opacity", String(INACTIVE_OVERLAY_OPACITY));
        rect.setAttribute("class", "inactive-overlay");
        svg.appendChild(rect);
      }
    }
  }
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

const SELECTION_MARKER_COLOR = "#1A7F37";
const SELECTION_MARKER_PADDING = 25; // px above/below a system's actual note extent

// Live preview of what would be selected if you clicked right now — like the
// blue playback cursor, but green. Before the first click, previews a single
// measure under the mouse; after it, previews the full start-to-hover range
// so picking the end point isn't a guessing game. Draws one rect per system
// (line) the range touches, rather than one bounding box over everything in
// between, so a range spanning multiple lines doesn't paint over unrelated
// staff area.
function drawSelectionPreview(startStep, endStep) {
  const svg = osmdContainer.querySelector("svg");
  if (!svg) return;
  clearSelectionPreview();
  if (startStep == null || endStep == null) return;

  const lo = Math.min(startStep, endStep);
  const hi = Math.max(startStep, endStep);

  for (const system of measureSystems) {
    const zonesInRange = system.zones.filter((z) => z.lastStep >= lo && z.firstStep <= hi);
    if (zonesInRange.length === 0) continue;

    const minX = Math.min(...zonesInRange.map((z) => z.minX));
    const maxX = Math.max(...zonesInRange.map((z) => z.maxX));
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", minX - 6);
    rect.setAttribute("width", maxX - minX + 12);
    rect.setAttribute("y", system.minY - SELECTION_MARKER_PADDING);
    rect.setAttribute("height", system.maxY - system.minY + SELECTION_MARKER_PADDING * 2);
    rect.setAttribute("fill", SELECTION_MARKER_COLOR);
    rect.setAttribute("fill-opacity", "0.25");
    rect.setAttribute("class", "selection-start-marker");
    svg.appendChild(rect);
  }
}

function clearSelectionPreview() {
  osmdContainer.querySelectorAll(".selection-start-marker").forEach((el) => el.remove());
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
  clearSelectionPreview();
  osmdContainer.classList.remove("selecting-section");
  selectSectionButton.textContent = "Practice a section…";
  selectSectionButton.classList.remove("selecting");
  setSectionInstructions("");
}

function measureNumberForStep(step) {
  const entry = pieceNoteCache.find((e) => e.stepIndex === step);
  return entry ? entry.measureNumber : null;
}

function measureRangeLabel(startStep, endStep) {
  const startMeasure = measureNumberForStep(startStep);
  const endMeasure = measureNumberForStep(endStep);
  if (startMeasure == null || endMeasure == null) return "selected range";
  return startMeasure === endMeasure ? `measure ${startMeasure}` : `measures ${startMeasure}–${endMeasure}`;
}

function startSectionPractice(startStep, endStep) {
  preSectionPosition = matcher.totalAdvances;
  heldNoteMarkers = new Map();
  clearSelectionPreview();
  matcher.startSection(startStep, endStep);
  redrawInactiveOverlay();

  osmdContainer.classList.remove("selecting-section");
  selectSectionButton.hidden = true;
  exitSectionButton.hidden = false;
  saveSectionButton.hidden = false;
  setSectionInstructions(`Practicing ${measureRangeLabel(startStep, endStep)} on a loop.`);
}

function exitSectionPractice() {
  if (!matcher) return;
  matcher.stopSection();
  heldNoteMarkers = new Map();
  matcher.start(preSectionPosition);
  redrawInactiveOverlay(); // un-grey the rest of the piece (unless a single hand is also selected)

  selectSectionButton.hidden = false;
  exitSectionButton.hidden = true;
  saveSectionButton.hidden = true;
  setSectionInstructions("");
}

function renderSavedSections() {
  savedSectionsList.innerHTML = "";
  if (!currentEntry) return;

  for (const section of currentEntry.progress.savedSections) {
    const chip = document.createElement("span");
    chip.className = "saved-section-chip";

    const label = document.createElement("span");
    label.textContent = `${section.name} (${measureRangeLabel(section.startStep, section.endStep)})`;
    chip.appendChild(label);

    const practiceBtn = document.createElement("button");
    practiceBtn.className = "practice-saved-section";
    practiceBtn.type = "button";
    practiceBtn.textContent = "▶";
    practiceBtn.title = "Practice this saved section";
    practiceBtn.addEventListener("click", () => {
      cancelSectionSelection();
      startSectionPractice(section.startStep, section.endStep);
    });
    chip.appendChild(practiceBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-saved-section";
    deleteBtn.type = "button";
    deleteBtn.textContent = "✕";
    deleteBtn.title = "Delete this saved section";
    deleteBtn.addEventListener("click", () => {
      currentEntry.progress.savedSections = currentEntry.progress.savedSections.filter((s) => s.id !== section.id);
      saveCurrentEntry();
      renderSavedSections();
    });
    chip.appendChild(deleteBtn);

    savedSectionsList.appendChild(chip);
  }
}

saveSectionButton.addEventListener("click", () => {
  if (!matcher || matcher.sectionEnd == null || !currentEntry) return;
  const suggested = measureRangeLabel(matcher.sectionStart, matcher.sectionEnd);
  const name = prompt("Name this section:", suggested);
  if (!name) return;
  currentEntry.progress.savedSections.push({
    id: crypto.randomUUID(),
    name,
    startStep: matcher.sectionStart,
    endStep: matcher.sectionEnd,
  });
  saveCurrentEntry();
  renderSavedSections();
});

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
    drawSelectionPreview(zone.firstStep, zone.lastStep);
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

// Live preview while picking a section: before the first click, shows what
// a click right now would select as the start; after it, shows the full
// start-to-hover range, so the second click isn't a guess.
osmdContainer.addEventListener("mousemove", (event) => {
  if (!sectionSelectionState) return;
  const svg = osmdContainer.querySelector("svg");
  if (!svg) return;

  const pt = screenToSvgPoint(svg, event.clientX, event.clientY);
  if (!pt) return;
  const hoverZone = findNearestMeasureZone(measureZones, pt.x, pt.y);
  if (!hoverZone) return;

  if (sectionSelectionState === "awaiting-start") {
    drawSelectionPreview(hoverZone.firstStep, hoverZone.lastStep);
  } else if (sectionSelectionState === "awaiting-end") {
    drawSelectionPreview(sectionStartStep, hoverZone.lastStep);
  }
});

async function openPiece(id) {
  const [fileContent, progressRecord] = await Promise.all([getFileContent(id), getProgress(id)]);
  if (!fileContent) return;

  // Merge over defaults (not just fall back to them) so settings added after a
  // file was first saved — like hand mode — still get a sane value.
  const settings = { ...DEFAULT_SETTINGS, ...progressRecord?.settings };
  const progress = { ...defaultProgress(), ...progressRecord?.progress };
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
  saveSectionButton.hidden = true;
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
    ({ zones: measureZones, systems: measureSystems } = buildMeasureZones(pieceNoteCache));
    // Needs pieceNoteCache populated first, since chip labels look up
    // measure numbers from it.
    renderSavedSections();

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
      redrawInactiveOverlay();
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
    redrawInactiveOverlay();
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
      putProgress({ id, settings: { ...DEFAULT_SETTINGS }, progress: defaultProgress(), updatedAt: now }),
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
      putProgress({ id, settings: { ...DEFAULT_SETTINGS }, progress: defaultProgress(), updatedAt: now }),
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
