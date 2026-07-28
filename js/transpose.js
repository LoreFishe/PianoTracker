// Diatonic transposition: shifts a MusicXML document by scale degree and
// semitone together, so the key signature and every note's spelling stay
// musically correct in the target key — not a chromatic pitch-shift with a
// sharps/flats lookup table. OSMD has no transpose API of its own, so this
// operates directly on the parsed MusicXML DOM before it reaches OSMD (which
// accepts a Document directly via osmd.load(), so no re-serialization needed).

const STEPS = "CDEFGAB";
const STEP_SEMITONES = [0, 2, 4, 5, 7, 9, 11]; // natural pitch of C D E F G A B within an octave

// Indexed by pitch class 0–11. Each row is that pitch class's canonical
// spelling as a major-key tonic: { step (0=C..6=B), alter, fifths, name }.
const MAJOR_KEYS = [
  { step: 0, alter: 0, fifths: 0, name: "C" },
  { step: 1, alter: -1, fifths: -5, name: "D♭" },
  { step: 1, alter: 0, fifths: 2, name: "D" },
  { step: 2, alter: -1, fifths: -3, name: "E♭" },
  { step: 2, alter: 0, fifths: 4, name: "E" },
  { step: 3, alter: 0, fifths: -1, name: "F" },
  { step: 3, alter: 1, fifths: 6, name: "F♯" },
  { step: 4, alter: 0, fifths: 1, name: "G" },
  { step: 5, alter: -1, fifths: -4, name: "A♭" },
  { step: 5, alter: 0, fifths: 3, name: "A" },
  { step: 6, alter: -1, fifths: -2, name: "B♭" },
  { step: 6, alter: 0, fifths: 5, name: "B" },
];

// Same idea, but each pitch class spelled as a minor-key tonic (a third below
// its relative major — same fifths as that major).
const MINOR_KEYS = [
  { step: 0, alter: 0, fifths: -3, name: "C" },
  { step: 0, alter: 1, fifths: 4, name: "C♯" },
  { step: 1, alter: 0, fifths: -1, name: "D" },
  { step: 1, alter: 1, fifths: 6, name: "D♯" },
  { step: 2, alter: 0, fifths: 1, name: "E" },
  { step: 3, alter: 0, fifths: -4, name: "F" },
  { step: 3, alter: 1, fifths: 3, name: "F♯" },
  { step: 4, alter: 0, fifths: -2, name: "G" },
  { step: 4, alter: 1, fifths: 5, name: "G♯" },
  { step: 5, alter: 0, fifths: 0, name: "A" },
  { step: 6, alter: -1, fifths: -5, name: "B♭" },
  { step: 6, alter: 0, fifths: 2, name: "B" },
];

// Anything other than major/minor (e.g. a modal piece) is treated as major
// for spelling purposes — real church-mode support isn't in scope here.
function keyTableForMode(mode) {
  return mode === "minor" ? MINOR_KEYS : MAJOR_KEYS;
}

function pitchClassOf(step, alter) {
  return ((STEP_SEMITONES[step] + alter) % 12 + 12) % 12;
}

/** Reads the first <attributes><key> in a MusicXML document (fifths + mode).
 * Defaults to C major if the document has none — a malformed or unusual file
 * shouldn't crash the transpose engine, just fall back sanely. */
export function detectSourceKey(doc) {
  const keyEl = doc.querySelector("key");
  const fifths = keyEl ? Number(keyEl.querySelector("fifths")?.textContent ?? 0) : 0;
  const modeText = keyEl?.querySelector("mode")?.textContent?.trim().toLowerCase();
  const mode = modeText === "minor" ? "minor" : "major";
  const table = keyTableForMode(mode);
  const row = table.find((r) => r.fifths === fifths) ?? table[0];
  return { mode, fifths: row.fifths, step: row.step, alter: row.alter, pitchClass: pitchClassOf(row.step, row.alter) };
}

/** The key `transposeSemitones` (0–11) above `sourceKey`, same mode — just the
 * identity/name, without transforming a whole document. Used for UI labels
 * (the stepper's current key, the key pill). */
export function describeTargetKey(sourceKey, transposeSemitones) {
  const table = keyTableForMode(sourceKey.mode);
  const targetPitchClass = ((sourceKey.pitchClass + transposeSemitones) % 12 + 12) % 12;
  const row = table[targetPitchClass];
  return {
    mode: sourceKey.mode,
    fifths: row.fifths,
    step: row.step,
    alter: row.alter,
    pitchClass: targetPitchClass,
    name: `${row.name} ${sourceKey.mode}`,
  };
}

/** Transposes an already-parsed MusicXML `doc` in place, up `transposeSemitones`
 * (0–11) semitones — callers that also need the source key (for a key pill,
 * a stepper label) should parse once and pass the same Document to both
 * detectSourceKey and here, rather than parsing the same text twice. Every
 * note is shifted by the same generic (letter) + specific (semitone) interval —
 * reduced to whichever direction (up or down) stays within a tritone of the
 * original, so transposing "up 10 semitones" doesn't push the piece up
 * almost a full octave when "down 2" reaches the same pitch class. This is
 * what guarantees correct spelling for chromatic/passing notes too, not just
 * scale tones — it's a pure transposition by interval, not a re-spelling
 * heuristic. Every <key><fifths> is shifted by the same delta, so internal
 * modulations stay consistent relative to the new tonic. */
export function transposeMusicXml(doc, transposeSemitones) {
  if (!transposeSemitones) return doc;

  const sourceKey = detectSourceKey(doc);
  const targetKey = describeTargetKey(sourceKey, transposeSemitones);

  const rawGenericShift = ((targetKey.step - sourceKey.step) % 7 + 7) % 7;
  const rawSemitoneShift = ((targetKey.pitchClass - sourceKey.pitchClass) % 12 + 12) % 12;
  const overAnOctaveNearer = rawSemitoneShift > 6;
  const appliedSemitoneShift = overAnOctaveNearer ? rawSemitoneShift - 12 : rawSemitoneShift;
  const appliedGenericShift = overAnOctaveNearer ? rawGenericShift - 7 : rawGenericShift;
  const fifthsDelta = targetKey.fifths - sourceKey.fifths;

  for (const pitchEl of doc.querySelectorAll("pitch")) {
    const stepEl = pitchEl.querySelector("step");
    const octaveEl = pitchEl.querySelector("octave");
    if (!stepEl || !octaveEl) continue;
    const alterEl = pitchEl.querySelector("alter");

    const step = STEPS.indexOf(stepEl.textContent.trim());
    const alter = alterEl ? Number(alterEl.textContent) : 0;
    const octave = Number(octaveEl.textContent);

    const absoluteSemitone = STEP_SEMITONES[step] + alter + 12 * octave;
    const targetAbsolute = absoluteSemitone + appliedSemitoneShift;
    const newStep = ((step + appliedGenericShift) % 7 + 7) % 7;
    const newOctave = Math.round((targetAbsolute - STEP_SEMITONES[newStep]) / 12);
    const newAlter = targetAbsolute - STEP_SEMITONES[newStep] - 12 * newOctave;

    stepEl.textContent = STEPS[newStep];
    octaveEl.textContent = String(newOctave);
    if (newAlter !== 0) {
      if (alterEl) {
        alterEl.textContent = String(newAlter);
      } else {
        const el = doc.createElement("alter");
        el.textContent = String(newAlter);
        stepEl.after(el);
      }
    } else if (alterEl) {
      alterEl.remove();
    }

    // OSMD infers the correct accidental glyph from alter + the (now updated)
    // key signature — a stale <accidental> from the original key would
    // otherwise mismatch what the note now actually is.
    pitchEl.parentElement.querySelector("accidental")?.remove();
  }

  for (const fifthsEl of doc.querySelectorAll("key > fifths")) {
    fifthsEl.textContent = String(Number(fifthsEl.textContent) + fifthsDelta);
  }

  return doc;
}
