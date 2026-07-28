// Chord detection + Roman-numeral/scale-degree labeling for the Live
// Analysis HUD. Deliberately exact-match only (see detectChord) — a wrong
// guess at an unusual note cluster is worse than admitting no chord matched,
// for a tool whose whole point is training the ear to trust what it hears.

const PITCH_CLASS_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

// { quality, symbol (chord-name suffix, e.g. "Cm7"), lowercase (Roman
// numeral case), numeralSuffix (e.g. "7", "°", "maj7") }. Intervals are
// semitones from the root, ascending.
const CHORD_TEMPLATES = [
  { quality: "major", intervals: [0, 4, 7], symbol: "", lowercase: false, numeralSuffix: "" },
  { quality: "minor", intervals: [0, 3, 7], symbol: "m", lowercase: true, numeralSuffix: "" },
  { quality: "diminished", intervals: [0, 3, 6], symbol: "dim", lowercase: true, numeralSuffix: "°" },
  { quality: "augmented", intervals: [0, 4, 8], symbol: "aug", lowercase: false, numeralSuffix: "+" },
  { quality: "dominant7", intervals: [0, 4, 7, 10], symbol: "7", lowercase: false, numeralSuffix: "7" },
  { quality: "major7", intervals: [0, 4, 7, 11], symbol: "maj7", lowercase: false, numeralSuffix: "maj7" },
  { quality: "minor7", intervals: [0, 3, 7, 10], symbol: "m7", lowercase: true, numeralSuffix: "7" },
  { quality: "minorMajor7", intervals: [0, 3, 7, 11], symbol: "m(maj7)", lowercase: true, numeralSuffix: "(maj7)" },
  { quality: "halfDiminished7", intervals: [0, 3, 6, 10], symbol: "m7♭5", lowercase: true, numeralSuffix: "ø7" },
  { quality: "diminished7", intervals: [0, 3, 6, 9], symbol: "dim7", lowercase: true, numeralSuffix: "°7" },
  { quality: "sus2", intervals: [0, 2, 7], symbol: "sus2", lowercase: false, numeralSuffix: "sus2" },
  { quality: "sus4", intervals: [0, 5, 7], symbol: "sus4", lowercase: false, numeralSuffix: "sus4" },
];

// Scale-degree reference is each mode's own diatonic collection — major
// scale for major keys, *natural* minor for minor keys (not harmonic/melodic)
// — so a chord built on the raised leading tone in a minor key (very common,
// e.g. a vii° built from harmonic minor) correctly shows as "#VII°", not "VII°".
const MAJOR_DEGREES = ["I", "♭II", "II", "♭III", "III", "IV", "♯IV", "V", "♭VI", "VI", "♭VII", "VII"];
const MINOR_DEGREES = ["I", "♭II", "II", "III", "♯III", "IV", "♯IV", "V", "VI", "♯VI", "VII", "♯VII"];

function pitchClassOf(midiNote) {
  return ((midiNote % 12) + 12) % 12;
}

/** Detects a chord from a list of held MIDI notes, requiring an *exact*
 * pitch-class-set match against the template library (no partial/closest
 * matches). Among ties (rare — a couple of the templates above are
 * transpositions of each other at specific roots), prefers whichever root
 * matches the lowest held note, the usual "what's in the bass" tie-break.
 * Returns null if 2 or fewer distinct pitch classes are held, or nothing
 * matches. */
export function detectChord(midiNotes) {
  const pitchClasses = [...new Set(midiNotes.map(pitchClassOf))];
  if (pitchClasses.length < 3) return null;
  const pcSet = new Set(pitchClasses);
  const bassPc = pitchClassOf(Math.min(...midiNotes));

  const matches = [];
  for (let root = 0; root < 12; root++) {
    for (const template of CHORD_TEMPLATES) {
      if (template.intervals.length !== pitchClasses.length) continue;
      const templatePcs = new Set(template.intervals.map((i) => (root + i) % 12));
      if (templatePcs.size !== pcSet.size) continue;
      let allMatch = true;
      for (const pc of pcSet) {
        if (!templatePcs.has(pc)) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) matches.push({ root, template });
    }
  }
  if (matches.length === 0) return null;

  const { root, template } = matches.find((m) => m.root === bassPc) ?? matches[0];
  return {
    root,
    quality: template.quality,
    name: `${PITCH_CLASS_NAMES[root]}${template.symbol}`,
    lowercase: template.lowercase,
    numeralSuffix: template.numeralSuffix,
  };
}

/** The Roman numeral for a detected chord's root, relative to `keyInfo`
 * (`{ pitchClass, mode }`, e.g. sourceKeyInfo/effectiveKeyInfo from
 * transpose.js) — e.g. a chord rooted a major 6th above a major tonic
 * reads "vi" before combining with its own quality's case/suffix. */
export function describeChordInKey(chord, keyInfo) {
  const table = keyInfo.mode === "minor" ? MINOR_DEGREES : MAJOR_DEGREES;
  const distance = ((chord.root - keyInfo.pitchClass) % 12 + 12) % 12;
  const base = chord.lowercase ? table[distance].toLowerCase() : table[distance];
  return `${base}${chord.numeralSuffix}`;
}

/** Arabic scale-degree label (with accidental if chromatic) for a single
 * held note relative to `keyInfo` — independent of whether a full chord
 * matched, so the HUD can always show *something* for what's being played. */
export function degreeLabel(midiNote, keyInfo) {
  const distance = ((pitchClassOf(midiNote) - keyInfo.pitchClass) % 12 + 12) % 12;
  const numeral = (keyInfo.mode === "minor" ? MINOR_DEGREES : MAJOR_DEGREES)[distance];
  // Same table as the Roman numerals, just rendered as Arabic digits with a
  // leading accidental instead of roman numerals (1..7, not I..VII).
  const ROMAN_TO_ARABIC = { I: "1", II: "2", III: "3", IV: "4", V: "5", VI: "6", VII: "7" };
  const accidental = numeral.startsWith("♭") || numeral.startsWith("♯") ? numeral[0] : "";
  const roman = accidental ? numeral.slice(1) : numeral;
  return `${accidental}${ROMAN_TO_ARABIC[roman]}`;
}

/** Canonical pitch-class name (e.g. for note-name chips) — same spelling
 * convention as transpose.js's key tables. */
export function pitchClassName(pitchClass) {
  return PITCH_CLASS_NAMES[pitchClass];
}

const MINOR_ISH_QUALITIES = new Set(["minor", "diminished", "minor7", "minorMajor7", "halfDiminished7", "diminished7"]);

/** Whether a chord quality's color comes from a minor third — used to pick
 * which ring (major or minor) of the circle-of-fifths widget to highlight
 * for a detected chord. Sus chords have no third; treated as major-ish,
 * an arbitrary but harmless call since they're tonally ambiguous anyway. */
export function isMinorQuality(quality) {
  return MINOR_ISH_QUALITIES.has(quality);
}
