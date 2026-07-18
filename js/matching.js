function midiFromNote(note) {
  // OSMD's Note.halfTone uses a different zero point than MIDI note numbers;
  // empirically, MIDI note number = halfTone + 12 (verified against known XML octaves).
  return note.halfTone + 12;
}

function expectedNotesAtCursor(osmd) {
  return osmd.cursor
    .NotesUnderCursor()
    .filter((note) => !note.isRest())
    .map((note) => ({
      midi: midiFromNote(note),
      staffId: note.ParentStaffEntry.ParentStaff.Id,
    }));
}

/** Tracks the OSMD cursor against played MIDI notes, advancing when all
 * expected notes across both hands are held down together (octave-strict). */
export class NoteMatcher {
  constructor(osmd) {
    this.osmd = osmd;
    this.heldNotes = new Set();
    this.expected = [];
    this.onAdvance = null;
    this.onComplete = null;
  }

  start() {
    this.osmd.cursor.show();
    this.osmd.cursor.reset();
    this._updateExpected();
  }

  noteOn(midi) {
    this.heldNotes.add(midi);
    this._checkMatch();
  }

  noteOff(midi) {
    this.heldNotes.delete(midi);
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
  }

  _checkMatch() {
    if (this.expected.length === 0) return;
    const allHeld = this.expected.every((n) => this.heldNotes.has(n.midi));
    if (allHeld) {
      this.osmd.cursor.next();
      this._updateExpected();
    }
  }
}
