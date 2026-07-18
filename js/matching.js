// OSMD's Note.halfTone uses a different zero point than MIDI note numbers;
// empirically, MIDI note number = halfTone + 12 (verified against known XML octaves).
export function midiFromNote(note) {
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

const MAX_PIECE_WALK_STEPS = 50_000; // safety cap against a runaway loop on a malformed file

/** Walks every cursor step in the piece once, calling `onStep(stepIndex, notes)`
 * for each (rests excluded from `notes`). Restores the cursor to wherever it
 * started (or `resumeSteps` if given) when done — this is a read-only survey,
 * not a navigation. Hides the cursor during the walk to avoid per-step
 * scroll/visual-update overhead (this compounds badly in a tight loop on a
 * large piece otherwise). */
export function walkPiece(osmd, onStep, resumeSteps = 0) {
  osmd.cursor.hide();
  osmd.cursor.reset();
  let steps = 0;
  while (!osmd.cursor.iterator.EndReached && steps < MAX_PIECE_WALK_STEPS) {
    const notes = osmd.cursor.NotesUnderCursor().filter((note) => !note.isRest());
    onStep(steps, notes);
    osmd.cursor.next();
    steps++;
  }
  osmd.cursor.reset();
  for (let i = 0; i < resumeSteps; i++) osmd.cursor.next();
  osmd.cursor.show();
}

/** Extracts { midi, startSeconds, durationSeconds } for every note in
 * [startStep, endStep] (endStep null = to the end of the piece), for audio
 * preview playback. Timestamps are in whole-note units in MusicXML/OSMD;
 * secondsPerWholeNote converts using the piece's tempo (beats = quarter notes). */
export function extractPlaybackNotes(osmd, startStep, endStep, bpm, resumeSteps = 0) {
  const secondsPerWholeNote = 240 / bpm;
  const notes = [];
  let baseTimestamp = null;

  walkPiece(
    osmd,
    (stepIndex, stepNotes) => {
      if (stepIndex < startStep) return;
      if (endStep != null && stepIndex > endStep) return;
      for (const note of stepNotes) {
        const timestamp = note.getAbsoluteTimestamp().RealValue;
        if (baseTimestamp == null || timestamp < baseTimestamp) baseTimestamp = timestamp;
        notes.push({ midi: midiFromNote(note), timestamp, length: note.Length.RealValue });
      }
    },
    resumeSteps
  );

  return notes.map((n) => ({
    midi: n.midi,
    startSeconds: (n.timestamp - baseTimestamp) * secondsPerWholeNote,
    durationSeconds: n.length * secondsPerWholeNote,
  }));
}

// Standard grand-staff convention: top staff (1) = treble = right hand,
// bottom staff (2) = bass = left hand.
function handAllowsStaff(handMode, staffId) {
  if (handMode === "right") return staffId === 1;
  if (handMode === "left") return staffId === 2;
  return true; // 'both'
}

function expectedNotesAtCursor(osmd, handMode) {
  return osmd.cursor
    .NotesUnderCursor()
    .filter((note) => !note.isRest())
    .filter((note) => handAllowsStaff(handMode, note.ParentStaffEntry.ParentStaff.Id))
    .map((note) => ({
      midi: midiFromNote(note),
      staffId: note.ParentStaffEntry.ParentStaff.Id,
      note,
    }));
}

/** Tracks the OSMD cursor against played MIDI notes, advancing when all
 * expected notes (chords, across both hands) are held down together.
 * Octave strictness is toggleable: when off, any octave of the right
 * pitch class counts as correct. Hand mode ('both'/'right'/'left') excludes
 * the deselected hand's notes from what's required — positions where only
 * the deselected hand has a note are skipped automatically, same as rests. */
export class NoteMatcher {
  constructor(osmd, { octaveStrict = true, handMode = "both" } = {}) {
    this.osmd = osmd;
    this.octaveStrict = octaveStrict;
    this.handMode = handMode;
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
    // When set, practice loops within [sectionStart, sectionEnd] (both are
    // raw step indices, inclusive) instead of running to the end of the piece.
    this.sectionStart = null;
    this.sectionEnd = null;
    // () => void — fired each time a section loops back to its start
    this.onSectionLoop = null;
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

  /** Scopes practice to [startStep, endStep] (inclusive, raw step indices)
   * and jumps to startStep. Reaching the end of the section loops back to
   * the start instead of continuing into the rest of the piece. */
  startSection(startStep, endStep) {
    this.sectionStart = startStep;
    this.sectionEnd = endStep;
    this.start(startStep);
  }

  /** Returns to normal full-piece practice; does not move the cursor —
   * callers decide where practice should resume (e.g. via start()). */
  stopSection() {
    this.sectionStart = null;
    this.sectionEnd = null;
  }

  /** Re-filters the current position for the new hand mode without moving
   * the cursor; auto-skips forward if nothing is required here anymore. */
  setHandMode(mode) {
    this.handMode = mode;
    this._updateExpected();
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

    this.expected = expectedNotesAtCursor(this.osmd, this.handMode);

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
      if (this.sectionEnd != null && this.totalAdvances > this.sectionEnd) {
        this._loopSection();
      } else {
        this._updateExpected();
      }
    } else {
      this._recomputeFeedback();
    }
  }

  /** Just finished the last note/chord of the active section: jump back to
   * its start rather than continuing into the rest of the piece. */
  _loopSection() {
    this.osmd.cursor.reset();
    this.totalAdvances = 0;
    for (let i = 0; i < this.sectionStart; i++) {
      this.osmd.cursor.next();
      this.totalAdvances++;
    }
    this.onSectionLoop?.();
    this._updateExpected();
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
