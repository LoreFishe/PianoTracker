function midiFromNote(note) {
  // OSMD's Note.halfTone uses a different zero point than MIDI note numbers;
  // empirically, MIDI note number = halfTone + 12 (verified against known XML octaves).
  return note.halfTone + 12;
}

function pitchClass(midi) {
  return ((midi % 12) + 12) % 12;
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
  }

  start() {
    this.osmd.cursor.show();
    this.osmd.cursor.reset();
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
