const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function midiNoteToName(noteNumber) {
  const octave = Math.floor(noteNumber / 12) - 1;
  const name = NOTE_NAMES[noteNumber % 12];
  return `${name}${octave}`;
}

function handleMessage(msg, onNoteEvent) {
  const [status, note, velocity] = msg.data;
  const command = status & 0xf0;

  if (command === 0x90 && velocity > 0) {
    onNoteEvent({ type: "on", note, velocity, name: midiNoteToName(note) });
  } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
    onNoteEvent({ type: "off", note, velocity, name: midiNoteToName(note) });
  }
}

function attachInputs(midiAccess, onNoteEvent, onStatusChange) {
  const inputs = Array.from(midiAccess.inputs.values());
  inputs.forEach((input) => {
    input.onmidimessage = (msg) => handleMessage(msg, onNoteEvent);
  });
  onStatusChange({
    ok: inputs.length > 0,
    message:
      inputs.length > 0
        ? `Connected: ${inputs.map((i) => i.name).join(", ")}`
        : "No MIDI input devices found. Connect a keyboard and reload the page.",
  });
}

export async function initMidi(onNoteEvent, onStatusChange) {
  if (!navigator.requestMIDIAccess) {
    onStatusChange({ ok: false, message: "Web MIDI API is not supported in this browser. Use Chrome or Edge." });
    return null;
  }

  try {
    const midiAccess = await navigator.requestMIDIAccess();
    attachInputs(midiAccess, onNoteEvent, onStatusChange);
    midiAccess.onstatechange = () => attachInputs(midiAccess, onNoteEvent, onStatusChange);
    return midiAccess;
  } catch (err) {
    onStatusChange({ ok: false, message: `MIDI access denied or failed: ${err.message}` });
    return null;
  }
}
