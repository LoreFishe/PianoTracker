function midiFromNote(note) {
  // OSMD's Note.halfTone uses a different zero point than MIDI note numbers;
  // empirically, MIDI note number = halfTone + 12 (verified against known XML octaves).
  return note.halfTone + 12;
}

function pitchClass(midi) {
  return ((midi % 12) + 12) % 12;
}

// Maps a chromatic semitone (0=C..11=B) to its natural-letter staff step
// (C=0..B=6), treating black keys as sharps of the letter below (matches
// how OSMD/VexFlow space noteheads: C# sits on the C line, not the D line).
const SEMITONE_TO_STAFF_STEP = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const UNIT_TO_PX = 10; // OSMD's default EngravingRules.unitInPixels

function diatonicStep(midi) {
  const semitone = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12);
  return octave * 7 + SEMITONE_TO_STAFF_STEP[semitone];
}

/** Computes the pixel position (within OSMD's SVG) where `midi` would sit
 * on the staff, by taking the closest currently-expected note as a known
 * reference point and offsetting by the difference in staff steps. Every
 * staff step is exactly half a line-spacing apart (verified empirically).
 * Returns null if there's no expected note to anchor against. */
export function getStaffPositionForNote(osmd, expected, midi) {
  if (expected.length === 0) return null;
  const reference = expected.reduce((closest, exp) =>
    Math.abs(exp.midi - midi) < Math.abs(closest.midi - midi) ? exp : closest
  );
  try {
    const gnote = osmd.rules.GNote(reference.note);
    const refPos = gnote.PositionAndShape.AbsolutePosition;
    const stepDiff = diatonicStep(midi) - diatonicStep(reference.midi);
    return {
      x: refPos.x * UNIT_TO_PX,
      y: (refPos.y - 0.5 * stepDiff) * UNIT_TO_PX,
    };
  } catch {
    return null;
  }
}

/** Direct pixel position of a specific Note's rendered position — used for
 * highlighting expected/target notes, where we already have the exact Note
 * object rather than needing to guess the closest one. */
export function getNotePixelPosition(osmd, note) {
  try {
    const gnote = osmd.rules.GNote(note);
    const pos = gnote.PositionAndShape.AbsolutePosition;
    return { x: pos.x * UNIT_TO_PX, y: pos.y * UNIT_TO_PX };
  } catch {
    return null;
  }
}

function expectedNotesAtCursor(osmd) {
  return osmd.cursor
    .NotesUnderCursor()
    .filter((note) => !note.isRest())
    .map((note) => ({
      midi: midiFromNote(note),
      staffId: note.ParentStaffEntry.ParentStaff.Id,
      note,
    }));
}

/** Tracks the OSMD cursor against played MIDI notes, advancing when all
 * expected notes (chords, across both hands) are held down together.
 * Octave strictness is toggleable: when off, any octave of the right
 * pitch class counts as correct. */
export class NoteMatcher {
  constructor(osmd, { octaveStrict = true } = {}) {
    this.osmd = osmd;
    this.octaveStrict = octaveStrict;
    this.heldNotes = new Set();
    // MIDI notes still physically held that satisfied the *previous* cursor
    // position (legato playing carries a finger over into the next chord).
    // Excluded from wrong-note detection until released, so advancing the
    // cursor doesn't retroactively flag a note that was just played correctly.
    this.graceNotes = new Set();
    this.expected = [];
    this.onAdvance = null;
    this.onComplete = null;
    // ({ wrong: number[], correctSoFar: {midi,staffId,note}[] }) => void
    this.onFeedbackChange = null;
    // (midi: number, isCorrect: boolean) => void — fired for every key press
    this.onNotePlayed = null;
    // Total raw cursor.next() calls since reset (both from real matches and
    // internal rest-skipping) — a stable position marker for resuming later.
    this.totalAdvances = 0;
  }

  /** Starts the cursor at the beginning, then fast-forwards `resumeSteps`
   * raw advances to resume a previously saved position. */
  start(resumeSteps = 0) {
    this.osmd.cursor.show();
    this.osmd.cursor.reset();
    this.totalAdvances = 0;
    for (let i = 0; i < resumeSteps; i++) {
      this.osmd.cursor.next();
      this.totalAdvances++;
    }
    this._updateExpected();
  }

  setOctaveStrict(strict) {
    this.octaveStrict = strict;
    this._checkMatch();
  }

  noteOn(midi) {
    const isCorrect = this.expected.some((exp) => this._matches(midi, exp.midi));
    this.onNotePlayed?.(midi, isCorrect);
    this.heldNotes.add(midi);
    this._checkMatch();
  }

  noteOff(midi) {
    this.heldNotes.delete(midi);
    this.graceNotes.delete(midi);
    this._recomputeFeedback();
  }

  _matches(heldMidi, expectedMidi) {
    return this.octaveStrict ? heldMidi === expectedMidi : pitchClass(heldMidi) === pitchClass(expectedMidi);
  }

  _updateExpected() {
    if (this.osmd.cursor.iterator.EndReached) {
      this.expected = [];
      this.onComplete?.();
      this._recomputeFeedback();
      return;
    }

    this.expected = expectedNotesAtCursor(this.osmd);

    if (this.expected.length === 0) {
      // Rest-only position for both hands: nothing to wait for, skip ahead.
      this.osmd.cursor.next();
      this.totalAdvances++;
      this._updateExpected();
      return;
    }

    this.onAdvance?.(this.expected);
    this._recomputeFeedback();
  }

  _checkMatch() {
    if (this.expected.length === 0) return;
    const held = Array.from(this.heldNotes);
    const allHeld = this.expected.every((exp) => held.some((h) => this._matches(h, exp.midi)));
    if (allHeld) {
      this.graceNotes = new Set(this.heldNotes);
      this.osmd.cursor.next();
      this.totalAdvances++;
      this._updateExpected();
    } else {
      this._recomputeFeedback();
    }
  }

  _recomputeFeedback() {
    if (!this.onFeedbackChange) return;
    if (this.expected.length === 0) {
      this.onFeedbackChange({ wrong: [], correctSoFar: [] });
      return;
    }
    const held = Array.from(this.heldNotes);
    const wrong = held.filter(
      (h) => !this.graceNotes.has(h) && !this.expected.some((exp) => this._matches(h, exp.midi))
    );
    const correctSoFar = this.expected.filter((exp) => held.some((h) => this._matches(h, exp.midi)));
    this.onFeedbackChange({ wrong, correctSoFar });
  }
}
