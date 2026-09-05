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

## Roadmap

Built as a plain web app first; the plan is to wrap it with
[Capacitor](https://capacitorjs.com/) to ship it as an iOS app without
rewriting the UI or audio engine.
