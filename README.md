# Harmonize

A web app for learning to hear and sing harmony intervals.

## Tabs

- **Learn** — pick a key and scale, tap a note to sustain it, then hold a
  degree (3rd, 4th, 5th, 6th, 8th — above or below) to hear the harmony that
  belongs in that key against it. A piano graphic lights up both notes live.
- **Practice** — two drills, using the microphone to hear what you actually
  sing. *Note Harmonization* asks for a set interval above or below a note, and
  the key is irrelevant; you choose which notes it draws from and which
  intervals it asks for. *Scale Harmonization* asks for a scale degree, so
  whether the answer is major or minor depends on the key — you choose the key,
  the scale, and whether notes arrive at random or walk up the scale on repeat.
- **Play** — sing a melody, watch it transcribed to piano notes with the words
  you sang, fix any note it misheard, and hear the harmony it writes for you.
- **Quiz** — coming soon.

## Practice tracking

Practice keeps a record per person: a daily streak, how many notes you sang each
day and how many you got right. There are no accounts and no passwords — you
pick a name, and that name is how your streak finds you again. Names are unique
and matched case-insensitively, so typing an existing name resumes that record
rather than starting a second one. (The flip side: anyone who types your name
gets your stats. Fine for a practice tracker; don't put anything private in it.)

Each round ends one of two ways, and both are recorded:

- **Skip** — you didn't get it and moved on.
- **Next** — only available once you've sung the note correctly.

## Running it

Without a database, it's a static page with no build step — serve the folder
with any static file server and everything works except practice tracking,
which hides itself:

```
python3 -m http.server 8000
```

With tracking, run the small Node server, which serves the same page and adds
the stats API:

```
npm install
DATABASE_URL=postgresql://... npm start
```

It creates its own tables on boot. Without `DATABASE_URL` it still serves the
page and reports tracking as unavailable, rather than failing.

(Sample playback and the practice mic both load resources via `fetch`, which
browsers block from a bare `file://` URL — serve it over HTTP, even locally.)

## Deploying

Railway: point a service at this repo and add a Postgres database, then set the
service's `DATABASE_URL` to reference it (`${{Postgres.DATABASE_URL}}`).
`npm start` is the start command; `PORT` is supplied by the platform.

## Sound

Piano samples are from the FluidR3 GM soundfont (CC BY 3.0).
