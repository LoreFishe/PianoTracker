# Piano Practice Tracker

Browser-based sheet music practice tool. Renders MusicXML and tracks playing via a MIDI
keyboard, advancing through the score as correct notes are played. See [CLAUDE.md](CLAUDE.md)
for the full project spec and phase breakdown.

Plain HTML/CSS/JS, no build step. Deployed via GitHub Pages.

## Local development

Open `index.html` via a local server (not `file://`, since ES modules require HTTP):

```
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.
