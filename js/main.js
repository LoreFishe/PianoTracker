import { initMidi, midiNoteToName } from "./midi.js";
import { NoteMatcher } from "./matching.js";

const SAMPLE_FILE_URL = "samples/sample-grand-staff.musicxml";
const MAX_LOG_ENTRIES = 100;
const MAX_BADGES = 24;
const STAFF_LABELS = { 1: "Right hand", 2: "Left hand" };
const WRONG_NOTEHEAD_COLOR = "#CC0000";
const CORRECT_NOTEHEAD_COLOR = "#1A7F37";

let matcher = null;
let osmdInstance = null;
let coloredNotes = []; // Note objects currently painted red or green

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

function popNoteBadge(midi, isCorrect) {
  const feed = document.getElementById("played-notes-feed");
  const badge = document.createElement("span");
  badge.className = `note-badge ${isCorrect ? "correct" : "incorrect"}`;
  badge.textContent = midiNoteToName(midi);
  feed.appendChild(badge);

  while (feed.children.length > MAX_BADGES) {
    feed.removeChild(feed.firstChild);
  }
  feed.scrollLeft = feed.scrollWidth;
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
  matcher.onNotePlayed = popNoteBadge;
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
