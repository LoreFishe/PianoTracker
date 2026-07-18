import { initMidi, midiNoteToName } from "./midi.js";
import { NoteMatcher, getStaffPositionForNote } from "./matching.js";

const SAMPLE_FILE_URL = "samples/sample-grand-staff.musicxml";
const MAX_LOG_ENTRIES = 100;
const STAFF_LABELS = { 1: "Right hand", 2: "Left hand" };
const WRONG_NOTEHEAD_COLOR = "#CC0000";
const CORRECT_NOTEHEAD_COLOR = "#1A7F37";

let matcher = null;
let osmdInstance = null;
let coloredNotes = []; // Note objects currently painted red or green
let heldNoteMarkers = new Map(); // midi -> isCorrect, for notes currently held down

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
}

function renderComplete() {
  const el = document.getElementById("expected-notes");
  el.textContent = "Piece complete!";
  el.classList.add("complete");
}

function trackPlayedNote(midi, isCorrect) {
  heldNoteMarkers.set(midi, isCorrect);
}

function redrawPlayedNoteMarkers() {
  const svg = document.querySelector("#osmd-container svg");
  if (!svg) return;

  svg.querySelectorAll(".played-note-marker").forEach((el) => el.remove());
  if (!matcher) return;

  for (const [midi, isCorrect] of heldNoteMarkers) {
    const pos = getStaffPositionForNote(osmdInstance, matcher.expected, midi);
    if (!pos) continue;

    const marker = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
    marker.setAttribute("cx", pos.x);
    marker.setAttribute("cy", pos.y);
    marker.setAttribute("rx", "5.5");
    marker.setAttribute("ry", "4.5");
    marker.setAttribute("fill", isCorrect ? CORRECT_NOTEHEAD_COLOR : WRONG_NOTEHEAD_COLOR);
    marker.setAttribute("fill-opacity", "0.7");
    marker.setAttribute("stroke", "#ffffff");
    marker.setAttribute("stroke-width", "1");
    marker.setAttribute("class", "played-note-marker");
    svg.appendChild(marker);
  }
}

function applyFeedbackVisuals({ wrong, correctSoFar }) {
  const isWrong = wrong.length > 0;

  // Reset every previously-colored notehead, then re-color: red for the
  // target notes while a wrong note is held, green for expected notes
  // already correctly held (partial chord progress), visible at a glance.
  for (const note of coloredNotes) {
    note.NoteheadColor = undefined;
  }
  coloredNotes = [];

  if (isWrong) {
    for (const entry of matcher.expected) {
      entry.note.NoteheadColor = WRONG_NOTEHEAD_COLOR;
      coloredNotes.push(entry.note);
    }
  } else {
    for (const entry of correctSoFar) {
      entry.note.NoteheadColor = CORRECT_NOTEHEAD_COLOR;
      coloredNotes.push(entry.note);
    }
  }

  if (osmdInstance) {
    osmdInstance.render();
    osmdInstance.cursor.show();
  }
  redrawPlayedNoteMarkers();
}

async function loadSample() {
  const container = document.getElementById("osmd-container");
  const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(container, {
    autoResize: true,
    drawTitle: true,
    followCursor: true,
    cursorsOptions: [{ type: opensheetmusicdisplay.CursorType.Standard, color: "#3B82F6", alpha: 0.25, follow: true }],
  });
  osmdInstance = osmd;

  const response = await fetch(SAMPLE_FILE_URL);
  const musicXmlText = await response.text();

  await osmd.load(musicXmlText);
  osmd.render();

  const octaveStrictToggle = document.getElementById("octave-strict-toggle");
  matcher = new NoteMatcher(osmd, { octaveStrict: octaveStrictToggle.checked });
  matcher.onAdvance = renderExpectedNotes;
  matcher.onComplete = renderComplete;
  matcher.onFeedbackChange = applyFeedbackVisuals;
  matcher.onNotePlayed = trackPlayedNote;
  matcher.start();

  octaveStrictToggle.addEventListener("change", () => {
    matcher.setOctaveStrict(octaveStrictToggle.checked);
  });
}

loadSample().catch((err) => {
  console.error("Failed to load sample score:", err);
  const container = document.getElementById("osmd-container");
  container.textContent = "Failed to load sample score. See console for details.";
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
