import { initMidi, midiNoteToName } from "./midi.js";
import { NoteMatcher } from "./matching.js";

const SAMPLE_FILE_URL = "samples/sample-grand-staff.musicxml";
const MAX_LOG_ENTRIES = 100;
const STAFF_LABELS = { 1: "Right hand", 2: "Left hand" };
const WRONG_NOTEHEAD_COLOR = "#CC0000";

let matcher = null;
let osmdInstance = null;
let coloredWrongNotes = []; // Note objects currently painted red

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

function applyWrongNoteVisuals(wrongMidiNotes) {
  const feedbackEl = document.getElementById("wrong-note-feedback");
  const isWrong = wrongMidiNotes.length > 0;

  feedbackEl.hidden = !isWrong;
  if (isWrong) {
    feedbackEl.textContent = `Wrong note${wrongMidiNotes.length > 1 ? "s" : ""}: ${wrongMidiNotes
      .map(midiNoteToName)
      .join(", ")}`;
  }

  // Reset any previously-colored expected noteheads, then color the current
  // expected notes red while a wrong note is being held ("near the target").
  for (const note of coloredWrongNotes) {
    note.NoteheadColor = undefined;
  }
  coloredWrongNotes = isWrong ? matcher.expected.map((e) => e.note) : [];
  for (const note of coloredWrongNotes) {
    note.NoteheadColor = WRONG_NOTEHEAD_COLOR;
  }

  if (osmdInstance) {
    osmdInstance.render();
    osmdInstance.cursor.show();
  }
}

async function loadSample() {
  const container = document.getElementById("osmd-container");
  const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(container, {
    autoResize: true,
    drawTitle: true,
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
  matcher.onWrongNotesChange = applyWrongNoteVisuals;
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
      matcher.noteOff(event.note);
    }
  }
}

initMidi(logMidiEvent, setMidiStatus);
