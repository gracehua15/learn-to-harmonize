# Learn to Harmonize

A web app for learning to hear and sing harmony intervals.

## Modes

- **Learn** — pick a key/scale, tap a note in the grid to sustain it, then hold
  a Major 3rd / 5th (above or below) button to hear that harmony against the
  sustained note. A piano graphic lights up the base and harmony notes live.
- **Practice** — randomly generates a base note and asks you to sing one of
  the four intervals. Uses your microphone to detect the pitch you're
  actually singing in real time (note name + cents off) and tells you when
  you've matched the target. Filter which keys and which intervals are in
  the random pool.
- **Songs** — a browsable list of real songs; tap one and its melody plays on
  the piano. Reads `songs.json`, which you generate yourself (see Tools).
- **Quiz** — coming soon.

## Running it

This is a static site with no build step and no backend — open `index.html`
directly, or serve the folder with any static file server:

```
python3 -m http.server 8000
```

(Note: sample playback and the practice mic both need to load resources via
`fetch`, which some browsers block from a bare `file://` URL — serving it
over HTTP, even locally, avoids that.)

## Sound

Notes are real recorded piano samples (not synthesized), pitch-shifted onto
whichever note is pressed. See `samples/piano/CREDITS.md` for licensing.

## Tools

`tools/hooktheory_to_songs.py` builds the Songs tab's `songs.json` from the
[lead-sheet-dataset](https://github.com/wayne391/lead-sheet-dataset) export of
Hooktheory/TheoryTab lead sheets, where each song section already carries a
labelled monophonic melody:

```
python3 tools/hooktheory_to_songs.py path/to/datasets/event -o songs.json
```

`songs.json` is gitignored — the transcriptions are third-party and licensed for
academic use, so generate your own rather than committing one.

`tools/melody_to_piano.py` renders the melody line out of a
[POP909](https://github.com/music-x-lab/POP909-Dataset) song folder using the
same piano samples and voice engine the app uses in the browser:

```
python3 tools/melody_to_piano.py path/to/POP909/001 -o melody.wav --json melody.json
```

The JSON note list (`time`, `duration`, `midi`, `name`) is in the shape the
app's scheduler already wants, so it can drive playback directly.

## Roadmap

Built as a plain web app first; the plan is to wrap it with
[Capacitor](https://capacitorjs.com/) to ship it as an iOS app without
rewriting the UI or audio engine.
