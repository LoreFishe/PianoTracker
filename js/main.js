// Cache-busting query param on every internal import: GitHub Pages' default
// cache lifetime, combined with browsers not always revalidating on a plain
// reload, has repeatedly served stale JS after a deploy in testing. Bump
// this string (e.g. to today's date) whenever you deploy a real change.
import { initMidi, midiNoteToName } from "./midi.js?v=20260727-7";
import {
  NoteMatcher,
  getStaffPositionForNote,
  getNotePixelPosition,
  walkPiece,
  extractPlaybackNotes,
} from "./matching.js?v=20260727-7";
import { Player } from "./playback.js?v=20260727-7";
import {
  putFileContent,
  getFileContent,
  getAllFileContents,
  deleteFileContent,
  putProgress,
  getProgress,
  getAllProgress,
  deleteProgress,
} from "./db.js?v=20260727-7";
import { renderLibraryList, readUploadedFile } from "./library.js?v=20260727-7";
import { transposeMusicXml, detectSourceKey, describeTargetKey } from "./transpose.js?v=20260727-7";

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

const appEl = document.getElementById("app");
const mainWelcome = document.getElementById("main-welcome");
const mainFreeplay = document.getElementById("main-freeplay");
const mainPractice = document.getElementById("main-practice");
const hudEl = document.getElementById("hud");
const hudToggle = document.getElementById("hud-toggle");
const hudClose = document.getElementById("hud-close");
const wordmark = document.getElementById("wordmark");
const freePlayNav = document.getElementById("free-play-nav");
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
const keyPill = document.getElementById("key-pill");
const keyPillLabel = document.getElementById("key-pill-label");
const settingsGear = document.getElementById("settings-gear");
const settingsPopover = document.getElementById("settings-popover");
const settingsPopoverSubtitle = document.getElementById("settings-popover-subtitle");
const transposePrev = document.getElementById("transpose-prev");
const transposeNext = document.getElementById("transpose-next");
const transposeCurrent = document.getElementById("transpose-current");
const transposeReset = document.getElementById("transpose-reset");

const player = new Player();

// The piece's original (untransposed) key, detected once per load, and the
// currently-effective key after applying the piece's transposeSemitones
// setting — the single "current key" later phases (the HUD) will read from.
let sourceKeyInfo = null;
let effectiveKeyInfo = null;

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

const MAIN_PANELS = { welcome: mainWelcome, freeplay: mainFreeplay, practice: mainPractice };

// The sidebar (library + learning tools) stays mounted at all times; only the
// content inside `.main` swaps. Leaving "practice" always tears down the
// current piece's matcher/player state first, whichever panel comes next.
function setMainView(view) {
  if (MAIN_PANELS.practice !== MAIN_PANELS[view]) {
    player.stop();
    updatePlayButtonLabel();
    matcher = null;
    osmdInstance = null;
    currentEntry = null;
    sourceKeyInfo = null;
    effectiveKeyInfo = null;
    keyPill.hidden = true;
    settingsPopover.hidden = true;
    settingsGear.setAttribute("aria-expanded", "false");
  }
  for (const [key, panel] of Object.entries(MAIN_PANELS)) {
    panel.hidden = key !== view;
  }
  refreshLibraryList();
}

const DEFAULT_SETTINGS = { octaveStrict: true, handMode: "both", transposeSemitones: 0 };
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

function updateTransposeStepperLabel() {
  if (!currentEntry || !effectiveKeyInfo) return;
  transposeCurrent.textContent = effectiveKeyInfo.name;
  settingsPopoverSubtitle.textContent = currentEntry.fileName;

  const isTransposed = currentEntry.settings.transposeSemitones !== 0;
  transposeReset.hidden = !isTransposed;
  if (isTransposed) transposeReset.textContent = `Reset to original key (${describeTargetKey(sourceKeyInfo, 0).name})`;
}

// Persists the new transpose setting, then fully reloads the piece — the same
// path openPiece already uses, so the note cache/matcher/section zones are
// rebuilt fresh against the new pitches. Resuming mid-piece across a key
// change wouldn't make sense anyway (pieces already always start at the
// beginning on open). Awaits the write directly, rather than the fire-and-
// forget saveCurrentEntry(), since firing the reload before the write lands
// would race the very setting it's about to re-read.
async function setTransposeSemitones(newValue) {
  if (!currentEntry) return;
  currentEntry.settings.transposeSemitones = ((newValue % 12) + 12) % 12;
  currentEntry.updatedAt = Date.now();
  try {
    await putProgress({
      id: currentEntry.id,
      settings: currentEntry.settings,
      progress: currentEntry.progress,
      updatedAt: currentEntry.updatedAt,
    });
  } catch (err) {
    console.error("Failed to save progress:", err);
  }
  await openPiece(currentEntry.id);
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
    activeId: currentEntry?.id ?? null,
    onOpen: openPiece,
    onDelete: async (id) => {
      await Promise.all([deleteFileContent(id), deleteProgress(id)]);
      if (currentEntry?.id === id) setMainView("welcome");
      else refreshLibraryList();
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

  // The overlay carves a gap around the cursor's current position (see
  // redrawInactiveOverlay) — as the cursor advances, that gap needs to move
  // with it, or the piece would end up with a stale ungreyed hole wherever
  // the cursor used to be. Skipped in the common case (nothing greyed) to
  // keep the hot advance path free of unnecessary DOM work.
  if (matcher.handMode !== "both" || matcher.sectionStart != null) {
    redrawInactiveOverlay();
  }

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

// One zone per measure (step range, X/Y extent), derived from the note
// cache. Section-boundary clicks snap to whichever measure they land in
// rather than requiring a pixel-precise note hit — this is what lets
// clicking near a barline work as well as clicking a note, and incidentally
// makes it much harder to accidentally select a near-empty section from an
// imprecise click. Each zone's clickable X range is bounded by the *gaps* to
// its neighbors on the same line (not by nearest-center distance) so the
// decision boundary sits at the actual barline, not skewed toward whichever
// neighboring measure happens to have a wider spread of notes.
// Notes belonging to the same printed measure that are more than this many
// cursor steps apart are treated as two separate playback passes over that
// measure (a repeat sign OSMD's cursor unrolls during a linear walk), not
// one contiguous span — see the occurrences comment below.
const REPEAT_PASS_STEP_GAP = 100;

function buildMeasureZones(cache, osmd) {
  // Keyed by the actual SourceMeasure object, not its printed MeasureNumber:
  // real scores can restart the printed number (e.g. at a Coda) or repeat a
  // pickup measure's "0", and two different physical measures sharing the
  // same printed number must not be merged into one giant zone.
  const byMeasure = new Map();
  for (const entry of cache) {
    if (entry.x == null || entry.y == null) continue;
    const measure = entry.note.SourceMeasure;
    let zone = byMeasure.get(measure);
    if (!zone) {
      zone = {
        measureNumber: entry.measureNumber,
        // One {firstStep, lastStep} per contiguous playback pass. A measure
        // inside a repeated section is the same printed box on the page but
        // gets visited twice, at two far-apart step ranges, by OSMD's cursor
        // (which unrolls repeats for playback order) — merging those into a
        // single min..max span would make the zone's step range balloon to
        // cover everything between the two passes, corrupting section
        // selection and overlay coverage for the entire piece in between.
        occurrences: [],
        minX: entry.x,
        maxX: entry.x,
        minY: entry.y,
        maxY: entry.y,
        note: entry.note,
      };
      byMeasure.set(measure, zone);
    }
    const occurrences = zone.occurrences;
    const current = occurrences[occurrences.length - 1];
    if (current && entry.stepIndex <= current.lastStep + REPEAT_PASS_STEP_GAP) {
      current.lastStep = Math.max(current.lastStep, entry.stepIndex);
    } else {
      occurrences.push({ firstStep: entry.stepIndex, lastStep: entry.stepIndex });
    }
    zone.minX = Math.min(zone.minX, entry.x);
    zone.maxX = Math.max(zone.maxX, entry.x);
    zone.minY = Math.min(zone.minY, entry.y);
    zone.maxY = Math.max(zone.maxY, entry.y);
  }
  // firstStep/lastStep (used for click-to-select) is the *first* pass over
  // the measure — the intuitive target when a user clicks the printed box.
  const zones = Array.from(byMeasure.values()).map((zone) => ({
    ...zone,
    firstStep: zone.occurrences[0].firstStep,
    lastStep: zone.occurrences[0].lastStep,
  }));

  // Authoritative system (line) membership per measure, straight from OSMD's
  // own layout graph — NOT inferred from averaged note Y position. Y-
  // averaging was unreliable: a measure's average note Y shifts with the mix
  // of treble/bass notes it happens to contain, which could mis-cluster a
  // measure onto the wrong line, or worse, split a single measure's own
  // staff bands across two different inferred "systems" — silently dropping
  // overlay coverage for one of its two staves. calculateXPositionFromTimestamp
  // returns the actual MusicSystem OSMD placed a given timestamp's notes on.
  const rawSystems = new Map(); // MusicSystem.Id -> zones[]
  for (const zone of zones) {
    const [, musicSystem] = osmd.GraphicSheet.calculateXPositionFromTimestamp(zone.note.getAbsoluteTimestamp());
    if (!rawSystems.has(musicSystem.Id)) rawSystems.set(musicSystem.Id, []);
    rawSystems.get(musicSystem.Id).push(zone);
  }

  // Systems (lines), top to bottom, each with its own bounds — needed to draw
  // a live selection-range highlight that spans multiple lines correctly
  // (one rect per line the range touches, not one rect covering everything
  // in between, which would paint over unrelated staff area), and to grey
  // out one staff (hand) across a whole line independent of section bounds.
  const systems = Array.from(rawSystems.values())
    .sort((a, b) => Math.min(...a.map((z) => z.minY)) - Math.min(...b.map((z) => z.minY)))
    .map((zonesInSystem) => {
      zonesInSystem.sort((a, b) => a.minX - b.minX);
      zonesInSystem.forEach((zone, i) => {
        const prev = zonesInSystem[i - 1];
        const next = zonesInSystem[i + 1];
        zone.leftBound = prev ? (prev.maxX + zone.minX) / 2 : -Infinity;
        zone.rightBound = next ? (zone.maxX + next.minX) / 2 : Infinity;
      });

      // Set of actual SourceMeasure objects, not printed numbers — see the
      // byMeasure key above for why (a printed number can repeat across two
      // unrelated physical measures, which must not be merged here either).
      const measuresInSystem = new Set(zonesInSystem.map((z) => z.note.SourceMeasure));
      const staffBands = {};
      for (const entry of cache) {
        if (entry.y == null || !measuresInSystem.has(entry.note.SourceMeasure)) continue;
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

// Takes `measureSystems` (already grouped by OSMD's authoritative line
// membership, see buildMeasureZones) rather than a flat zone list, so
// "nearest line" is resolved by real system bounds instead of re-clustering
// by proximity a second time.
function findNearestMeasureZone(systems, x, y) {
  if (systems.length === 0) return null;

  let nearestSystem = systems[0];
  let bestYDist = Infinity;
  for (const system of systems) {
    const dist = Math.abs((system.minY + system.maxY) / 2 - y);
    if (dist < bestYDist) {
      bestYDist = dist;
      nearestSystem = system;
    }
  }

  const containing = nearestSystem.zones.find((z) => x >= z.leftBound && x < z.rightBound);
  if (containing) return containing;

  // Fallback (shouldn't normally hit, since bounds are -Infinity..Infinity
  // at the ends of each line): nearest center on the same line.
  let best = null;
  let bestDist = Infinity;
  for (const zone of nearestSystem.zones) {
    const dist = Math.abs((zone.minX + zone.maxX) / 2 - x);
    if (dist < bestDist) {
      bestDist = dist;
      best = zone;
    }
  }
  return best;
}

// px above/below a staff band's actual note extent. Generous on purpose:
// slurs and beam groups extend well past individual noteheads/stems, and a
// too-tight overlay left them poking out looking still "active".
const INACTIVE_OVERLAY_PADDING = 60;
const INACTIVE_OVERLAY_OPACITY = 0.65;
// Flat approximation of #osmd-container's paper gradient (css/styles.css,
// #F6F1E6 -> #EFE7D6) so the wash blends in instead of showing as a seam.
const INACTIVE_OVERLAY_FILL = "#F2ECDE";
// px; wide enough to cover a notehead + stem base, much narrower than the
// cursor's own ~30px width — see the cursor-gap patch in redrawInactiveOverlay.
const CURSOR_NOTE_PATCH_WIDTH = 16;

// OSMD's cursor is a plain <img> (cursorImg-0), a *sibling* of the SVG rather
// than an element inside it, deliberately given a negative z-index so it
// shows through the SVG's transparent (non-inked) areas without covering the
// notation ink. That means anything we add *inside* the SVG — including this
// overlay — always paints above it regardless of internal ordering: there's
// no z-index trick that fixes this from within the SVG. The fix is to carve
// the cursor's own rectangle out of the overlay bands it actually overlaps.
function getCursorRect() {
  const cursorImg = document.getElementById("cursorImg-0");
  if (!cursorImg || cursorImg.style.display === "none") return null;
  const left = parseFloat(cursorImg.style.left);
  const top = parseFloat(cursorImg.style.top);
  const width = cursorImg.width;
  const height = cursorImg.height;
  if (!Number.isFinite(left) || !Number.isFinite(top) || !width || !height) return null;
  return { left, right: left + width, top, bottom: top + height };
}

// Draws `rect(left..right, y, height)`, minus whatever slice of it overlaps
// `cursorRange` (splitting into up to two rects around the gap).
function addOverlayRect(svg, left, right, y, height, cursorRange) {
  const segments = [[left, right]];
  if (cursorRange && cursorRange.left < right && cursorRange.right > left) {
    segments.length = 0;
    if (cursorRange.left > left) segments.push([left, cursorRange.left]);
    if (cursorRange.right < right) segments.push([cursorRange.right, right]);
  }
  for (const [segLeft, segRight] of segments) {
    if (segRight <= segLeft) continue;
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", segLeft);
    rect.setAttribute("width", segRight - segLeft);
    rect.setAttribute("y", y);
    rect.setAttribute("height", height);
    rect.setAttribute("fill", INACTIVE_OVERLAY_FILL);
    rect.setAttribute("fill-opacity", String(INACTIVE_OVERLAY_OPACITY));
    rect.setAttribute("class", "inactive-overlay");
    svg.appendChild(rect);
  }
}

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
  const cursorRect = getCursorRect();
  // The gap that keeps the cursor's background vivid (below) also exposes
  // whichever note sits at the cursor's own step, if it belongs to an
  // inactive hand — pieceNoteCache lookup for patching that back in below.
  const currentStepEntries = cursorRect ? pieceNoteCache.filter((e) => e.stepIndex === matcher.totalAdvances) : [];

  for (const system of measureSystems) {
    for (const [staffIdStr, band] of Object.entries(system.staffBands)) {
      const staffId = Number(staffIdStr);
      const handOk = handMode === "both" || (handMode === "right" && staffId === 1) || (handMode === "left" && staffId === 2);
      const bandTop = band.minY - INACTIVE_OVERLAY_PADDING;
      const bandBottom = band.maxY + INACTIVE_OVERLAY_PADDING;
      // Only this specific band's row can visually collide with the cursor —
      // excluding the cursor's X range from every OTHER system/band too
      // (which happen to share the same X position on the page) would grey
      // out nothing in their entire column, well beyond the cursor itself.
      const cursorRange = cursorRect && cursorRect.top < bandBottom && cursorRect.bottom > bandTop ? cursorRect : null;

      for (const zone of system.zones) {
        // A repeated measure has multiple playback passes at this one printed
        // box (see occurrences comment in buildMeasureZones) — it counts as
        // "in section" if ANY pass overlaps, not just the first.
        const sectionOk =
          sectionStart == null ||
          zone.occurrences.some((occ) => occ.lastStep >= sectionStart && occ.firstStep <= sectionEnd);
        if (handOk && sectionOk) continue;

        const left = zone.leftBound === -Infinity ? zone.minX - INACTIVE_OVERLAY_PADDING : zone.leftBound;
        const right = zone.rightBound === Infinity ? zone.maxX + INACTIVE_OVERLAY_PADDING : zone.rightBound;
        addOverlayRect(svg, left, right, bandTop, bandBottom - bandTop, cursorRange);
      }

      // Patch the cursor's own note back in for this band, narrower than the
      // cursor itself — just enough to greyed the notehead/stem, not the
      // blank background around it that needs to stay vivid.
      if (!handOk && cursorRange) {
        for (const entry of currentStepEntries) {
          if (entry.staffId !== staffId || entry.x == null) continue;
          if (entry.x < cursorRange.left || entry.x > cursorRange.right) continue;
          addOverlayRect(
            svg,
            entry.x - CURSOR_NOTE_PATCH_WIDTH / 2,
            entry.x + CURSOR_NOTE_PATCH_WIDTH / 2,
            bandTop,
            bandBottom - bandTop,
            null
          );
        }
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

const SELECTION_MARKER_COLOR = "#1A7F37"; // green, same visual style as the blue playback cursor
const SELECTION_MARKER_PADDING = 25; // px above/below a system's actual note extent
const SELECTION_MARKER_WIDTH = 16; // matches the blue cursor's approximate width

function findNearestNoteEntry(cache, x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const entry of cache) {
    if (entry.x == null || entry.y == null) continue;
    const dist = (entry.x - x) ** 2 + (entry.y - y) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = entry;
    }
  }
  return best;
}

function findSystemForY(y) {
  let best = null;
  let bestDist = Infinity;
  for (const system of measureSystems) {
    const dist = Math.abs((system.minY + system.maxY) / 2 - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = system;
    }
  }
  return best;
}

// Live preview of exactly where a click would land — same visual language as
// the blue playback cursor (a thin bar, not a filled block), just green, and
// tracking the precise nearest note rather than a whole measure's width.
function drawSelectionPreview(pt) {
  const svg = osmdContainer.querySelector("svg");
  if (!svg) return;
  clearSelectionPreview();

  const noteEntry = findNearestNoteEntry(pieceNoteCache, pt.x, pt.y);
  if (!noteEntry) return;
  const system = findSystemForY(noteEntry.y);
  if (!system) return;

  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("x", noteEntry.x - SELECTION_MARKER_WIDTH / 2);
  rect.setAttribute("width", SELECTION_MARKER_WIDTH);
  rect.setAttribute("y", system.minY - SELECTION_MARKER_PADDING);
  rect.setAttribute("height", system.maxY - system.minY + SELECTION_MARKER_PADDING * 2);
  rect.setAttribute("fill", SELECTION_MARKER_COLOR);
  rect.setAttribute("fill-opacity", "0.3");
  rect.setAttribute("class", "selection-start-marker");
  svg.appendChild(rect);
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
    const zone = findNearestMeasureZone(measureSystems, pt.x, pt.y);
    if (!zone) return;
    sectionStartStep = zone.firstStep;
    sectionSelectionState = "awaiting-end";
    drawSelectionPreview(pt);
    setSectionInstructions("Click a measure to set the section end.");
    return;
  }
  if (sectionSelectionState === "awaiting-end") {
    const zone = findNearestMeasureZone(measureSystems, pt.x, pt.y);
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
  if (matcher.handMode !== "both" || matcher.sectionStart != null) {
    redrawInactiveOverlay();
  }
});

// Live preview while picking a section: a thin green bar (same style as the
// blue playback cursor) tracks the nearest note under the mouse, so you can
// see exactly where a click would land before committing to it.
osmdContainer.addEventListener("mousemove", (event) => {
  if (!sectionSelectionState) return;
  const svg = osmdContainer.querySelector("svg");
  if (!svg) return;

  const pt = screenToSvgPoint(svg, event.clientX, event.clientY);
  if (!pt) return;
  drawSelectionPreview(pt);
});

async function openPiece(id) {
  const [fileContent, progressRecord] = await Promise.all([getFileContent(id), getProgress(id)]);
  if (!fileContent) return;

  // Merge over defaults (not just fall back to them) so settings added after a
  // file was first saved — like hand mode — still get a sane value.
  const settings = { ...DEFAULT_SETTINGS, ...progressRecord?.settings };
  const progress = { ...defaultProgress(), ...progressRecord?.progress };
  currentEntry = { id, fileName: fileContent.fileName, settings, progress };

  setMainView("practice");
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

    const parsedDoc = new DOMParser().parseFromString(fileContent.musicXmlText, "application/xml");
    sourceKeyInfo = detectSourceKey(parsedDoc);
    effectiveKeyInfo = describeTargetKey(sourceKeyInfo, currentEntry.settings.transposeSemitones);
    keyPill.hidden = false;
    keyPillLabel.textContent = effectiveKeyInfo.name;
    updateTransposeStepperLabel();

    const scoreToLoad = currentEntry.settings.transposeSemitones
      ? transposeMusicXml(fileContent.musicXmlText, currentEntry.settings.transposeSemitones)
      : fileContent.musicXmlText;
    await osmd.load(scoreToLoad);
    osmd.render();
    pieceNoteCache = buildPieceNoteCache(osmd);
    ({ zones: measureZones, systems: measureSystems } = buildMeasureZones(pieceNoteCache, osmd));
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

settingsGear.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = settingsPopover.hidden;
  settingsPopover.hidden = !open;
  settingsGear.setAttribute("aria-expanded", String(open));
});

document.addEventListener("click", (event) => {
  if (settingsPopover.hidden) return;
  if (settingsPopover.contains(event.target) || settingsGear.contains(event.target)) return;
  settingsPopover.hidden = true;
  settingsGear.setAttribute("aria-expanded", "false");
});

transposePrev.addEventListener("click", () => {
  if (currentEntry) setTransposeSemitones(currentEntry.settings.transposeSemitones - 1);
});

transposeNext.addEventListener("click", () => {
  if (currentEntry) setTransposeSemitones(currentEntry.settings.transposeSemitones + 1);
});

transposeReset.addEventListener("click", () => {
  if (currentEntry) setTransposeSemitones(0);
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

wordmark.addEventListener("click", () => setMainView("welcome"));
freePlayNav.addEventListener("click", () => setMainView("freeplay"));

hudToggle.addEventListener("click", () => {
  const open = appEl.classList.toggle("hud-open");
  hudEl.hidden = !open;
  hudToggle.classList.toggle("on", open);
  hudToggle.setAttribute("aria-pressed", String(open));
});

hudClose.addEventListener("click", () => {
  appEl.classList.remove("hud-open");
  hudEl.hidden = true;
  hudToggle.classList.remove("on");
  hudToggle.setAttribute("aria-pressed", "false");
});

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
