# Piano Practice Tracker — Project Spec

## Overview

A browser-based sheet music practice tool, similar in spirit to Piano Marvel. It renders
MusicXML sheet music (exported from MuseScore) and tracks the user's playing via a MIDI
keyboard connected to a laptop, advancing through the score as correct notes are played.

**Platform for this phase: laptop / desktop browser only** (Chrome or Edge, which support
the Web MIDI API). An iPhone-compatible version is a known future goal but is explicitly
**out of scope** for this phase — see "Future Phases" at the bottom. Don't build toward iOS
constraints prematurely; optimize for a full-featured desktop experience first.

**Hosting:** static site on GitHub Pages. No backend, no server-side code, no user accounts.
All data lives in the browser (see Persistence section).

**Tooling:** plain HTML/CSS/JS, no build step, unless a specific phase hits a real technical
wall that requires one (e.g. a library that only ships as an ES module needing bundling).
Default to vanilla / CDN-loaded libraries. If a build step becomes necessary, flag it
explicitly before introducing it rather than adding tooling preemptively.

---

## Core Libraries

- **OpenSheetMusicDisplay (OSMD)** — renders MusicXML, provides a cursor API for stepping
  through the score.
- **Web MIDI API** (native browser API, no library needed) — reads input from the connected
  MIDI keyboard.
- **JSZip** (or similar) — needed to unpack compressed `.mxl` files (MusicXML files are
  sometimes zipped; see File Support below).

---

## File Support

The app should accept, at minimum:
- `.musicxml` / `.xml` — uncompressed MusicXML (MuseScore's standard export)
- `.mxl` — compressed MusicXML (zipped); unzip client-side before handing to OSMD

Goal: never force the user to pay for a conversion tool or external service. If a format
shows up later that isn't supported, prefer a client-side conversion path over asking the
user to go find another tool.

---

## Two-Hand (Grand Staff) Support

This is a **day-one requirement**, not a later addition. The app must track both the
treble and bass clef simultaneously — i.e., know the expected note(s) in both hands at
the current cursor position, and only advance when both hands' expected notes are
satisfied (subject to the matching rules below). This affects the cursor/matching design
from Phase 3 onward, so it's built in from the start rather than retrofitted.

---

## Note Matching Rules

- **Octave strictness**: ON by default. A played note must match the expected note's
  exact octave to count as correct. This is a toggleable **setting** (see Settings/Profiles
  below) — when turned off, any octave of the correct pitch class counts as correct.
- **Wrong notes**: if the user plays a note that isn't expected at the current position,
  it is displayed in **red** (both on the note itself if it's near the target, and/or as
  feedback near the cursor). The app does *not* advance the cursor on a wrong note — it
  keeps waiting for the correct note(s) in wait mode.
- **Chords**: all expected notes at a given cursor position (across both hands) must be
  held down together, within a reasonable tolerance window, before the cursor advances.

---

## Persistence & Library

Everything is stored client-side (localStorage or IndexedDB — decide during Phase 6 based
on data size; MusicXML files plus per-file metadata may exceed comfortable localStorage
limits, in which case IndexedDB is the fallback).

The app maintains a **library** of uploaded files. For each file, it stores:
- The file itself (so it doesn't need to be re-uploaded every session)
- Progress data (e.g. how far the user has gotten, accuracy history — exact shape TBD
  when we reach that phase)
- A **settings profile** scoped to that file (e.g. octave strictness on/off for that piece)

The user should be able to return to the app, see their library, pick a piece, and resume
with their prior settings intact.

---

## Modes

1. **Wait mode** (build first): the score does not advance until the correct note(s) are
   played. This is the primary mode for the first several phases.
2. **Play-along mode** (build later, once wait mode is solid): the score advances on a
   fixed tempo/metronome regardless of what's played, and accuracy is scored after the
   fact rather than gating progress.

---

## Phase Breakdown

Each phase should be independently demoable and verified by the user before moving to
the next. Don't bundle phases together or skip ahead even if it seems efficient — the
point of this structure is that each step is checkable in isolation.

### Phase 0 — Scaffold
- Repo structure set up, deployed to GitHub Pages
- Empty HTML shell loads at the Pages URL
- **Verify:** page loads in browser at the GitHub Pages URL, shows placeholder content

### Phase 1 — Score Rendering (Grand Staff)
- OSMD integrated, loads a hardcoded sample MusicXML file with both treble and bass clef
- Renders correctly on screen
- **Verify:** user sees real two-staff notation rendered from a sample file

### Phase 2 — MIDI Input Plumbing
- Web MIDI connects to the user's keyboard
- Note-on/note-off events logged visibly (console or on-screen debug output)
- **Verify:** user plays notes on their keyboard, sees them logged live in the browser

### Phase 3 — Cursor + Two-Hand Note Matching (Single Notes)
- OSMD cursor tracks position across both staves
- Compares played notes against expected notes in both hands
- Advances only when both hands' current single (non-chord) notes are correctly played
- **Verify:** user plays a simple two-hand melody (no chords yet), watches cursor advance
  correctly note-by-note across both staves

### Phase 4 — Chords, Wrong-Note Handling, Octave Setting
- Multi-note chords in either/both hands: all notes must be held before advancing
- Wrong notes shown in red, cursor does not advance
- Octave strictness setting implemented and toggleable
- **Verify:** user plays a piece with chords in both hands, tests deliberate wrong notes
  (sees red feedback, no advance), tests octave setting on/off behavior

### Phase 5 — Visual Feedback Polish
- Clear current-note highlighting, correct/incorrect coloring refined
- Legible at a glance while actively playing (not just after the fact)
- **Verify:** user plays through a piece and confirms the visual feedback is clear and
  doesn't get in the way while playing

### Phase 6 — File Library & Persistence
- Upload `.musicxml`/`.xml`/`.mxl` files, build a library UI
- Each file stores its own progress + settings profile (e.g. octave strictness)
- Data persists across page reloads/sessions
- **Verify:** user uploads 2-3 of their own real pieces, confirms they render and track
  correctly, reloads the page and confirms library/settings/progress persisted

### Phase 7 — Hand Isolation
- Practice mode selector: both hands / right hand only / left hand only
- In a single-hand mode, the deselected hand's notes are not required to advance —
  positions where only the deselected hand has a note are skipped automatically, the
  same way rest-only positions already are
- Persisted per-file alongside octave strictness
- **Verify:** user selects right-hand-only on a two-hand piece, confirms the cursor
  advances on right-hand notes alone and never waits on the left hand; same for
  left-hand-only

### Phase 8 — Section/Range Practice
- User can select an arbitrary start and end point in the piece by clicking notes
  directly on the rendered score, then practice just that section on a loop
- Looping a section does not overwrite the piece's overall saved resume position
- **Verify:** user selects a section in the middle of a piece, confirms practice is
  scoped to it (loops back to the section start on completion, doesn't require playing
  the rest of the piece), and confirms leaving section mode resumes normal full-piece
  progress

### Phase 9 — Play-Along Mode
- Tempo/metronome-driven playback that scrolls the score regardless of input
- Post-hoc accuracy scoring instead of gating advancement
- **Verify:** user plays through a piece in play-along mode at a set tempo, reviews the
  resulting accuracy summary and confirms it's sensible

---

## Future Phases (not in this document's critical path)

- **iPhone port**: Web MIDI API is not supported by any browser on iOS (all iOS browsers
  are required to use WebKit, which lacks Web MIDI support). Realistic paths when this
  becomes a priority: (a) a microphone-based pitch-detection fallback usable in any iOS
  browser, or (b) a thin native wrapper (e.g. Capacitor or a Swift/WKWebView shell) using
  Apple's CoreMIDI to bridge Bluetooth MIDI input into the existing web UI. Neither should
  influence the architecture of the laptop-first build unless it turns out to be free to
  do so.
- Deeper progress analytics / accuracy trends over time
- Rhythm/timing-based grading (not just correct pitches, but correct timing)
- Lesson structuring, sequencing multiple pieces into a curriculum

---

## Open Decisions to Resolve Mid-Project

- **localStorage vs. IndexedDB** for the file library — decide in Phase 6 based on actual
  data volume once real files are being tested.
- **Progress data shape** — what exactly gets tracked per file (last position reached,
  accuracy over time, number of sessions, etc.) — define concretely at the start of
  Phase 6, not before, since it's easier to design once wait-mode mechanics are proven out.
