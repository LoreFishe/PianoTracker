import { initMidi, midiNoteToName } from "./midi.js";
import { NoteMatcher } from "./matching.js";

const SAMPLE_FILE_URL = "samples/sample-grand-staff.musicxml";
const MAX_LOG_ENTRIES = 100;
const STAFF_LABELS = { 1: "Right hand", 2: "Left hand" };

let matcher = null;

function renderExpectedNotes(expected) {
  const el = document.getElementById("expected-notes");
  const parts = expected.map((n) => `${STAFF_LABELS[n.staffId] ?? `Staff ${n.staffId}`}: ${midiNoteToName(n.midi)}`);
  el.textContent = `Waiting for — ${parts.join("   |   ")}`;
  el.classList.remove("complete");
}

function renderComplete() {
  const el = document.getElementById("expected-notes");
  el.textContent = "Piece complete!";
  el.classList.add("complete");
}

async function loadSample() {
  const container = document.getElementById("osmd-container");
  const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(container, {
    autoResize: true,
    drawTitle: true,
  });

  const response = await fetch(SAMPLE_FILE_URL);
  const musicXmlText = await response.text();

  await osmd.load(musicXmlText);
  osmd.render();

  matcher = new NoteMatcher(osmd);
  matcher.onAdvance = renderExpectedNotes;
  matcher.onComplete = renderComplete;
  matcher.start();
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
