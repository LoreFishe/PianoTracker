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
    this.onWrongNotesChange = null;
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
    this.heldNotes.add(midi);
    this._checkMatch();
  }

  noteOff(midi) {
    this.heldNotes.delete(midi);
    this.graceNotes.delete(midi);
    this._recomputeWrongNotes();
  }

  _matches(heldMidi, expectedMidi) {
    return this.octaveStrict ? heldMidi === expectedMidi : pitchClass(heldMidi) === pitchClass(expectedMidi);
  }

  _updateExpected() {
    if (this.osmd.cursor.iterator.EndReached) {
      this.expected = [];
      this.onComplete?.();
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
    this._recomputeWrongNotes();
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
      this._recomputeWrongNotes();
    }
  }

  _recomputeWrongNotes() {
    if (!this.onWrongNotesChange) return;
    if (this.expected.length === 0) {
      this.onWrongNotesChange([]);
      return;
    }
    const wrong = Array.from(this.heldNotes).filter(
      (h) => !this.graceNotes.has(h) && !this.expected.some((exp) => this._matches(h, exp.midi))
    );
    this.onWrongNotesChange(wrong);
  }
}
