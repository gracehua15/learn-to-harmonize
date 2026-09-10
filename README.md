# Harmonize

A web app for learning to hear and sing harmony intervals.

## Screens

A home screen with one door per activity, and a Home button back out of each —
on a phone a tab bar spends a row of screen on every view and still doesn't say
where you are.

- **Learn** — pick a key and scale, tap a note to sustain it, then hold a
  degree (3rd, 4th, 5th, 6th, 8th — above or below) to hear the harmony that
  belongs in that key against it. A piano graphic lights up both notes live.
- **Practice** — two drills, using the microphone to hear what you actually
  sing. *Note Harmonization* asks for a set interval above or below a note, and
  the key is irrelevant; you choose which notes it draws from and which
  intervals it asks for. *Scale Harmonization* asks for a scale degree, so
  whether the answer is major or minor depends on the key — you choose the key,
  the scale, and whether notes arrive at random or walk up the scale on repeat.
- **Play** — build a melody two ways: *record singing*, which transcribes what
  you sang into piano notes with the words alongside them, or *play piano*,
  tapping the notes in exactly. Either way you can fix any note, hear the
  harmony it writes for you, and save the result to the shared library under a
  song, artist, and which part of the song it is. Anyone can add to the library
  and open anyone else's melody to edit.

  Note lengths come off one ladder of standard values — sixteenth through whole
  at 120 bpm — so Shorter and Longer land on lengths you can reason about rather
  than scaling each note by a percentage into its own odd number.
- **Split a track** — hand it an audio file and it comes back as two: the part
  you asked for (vocals, piano, guitar, bass or drums) and everything else,
  both playable in the page and downloadable. Meant for your own recordings
  and anything you hold the rights to. The door only appears when the server
  has a splitting key.
- **Melody library** — everything anyone has saved, opened straight into Play
  to edit. The door only appears once there is something behind it.

Practice is a short path rather than one long page: your name, then what you
came for, then which drill, then its options, then the round itself — each with
a way back to the step before.

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

It creates its own tables on boot (`users`, `attempts`, `melodies`). Without
`DATABASE_URL` it still serves the page and reports tracking as unavailable,
rather than failing — practice runs untracked and the library hides itself.

(Sample playback and the practice mic both load resources via `fetch`, which
browsers block from a bare `file://` URL — serve it over HTTP, even locally.)

Splitting is a separate switch on the same server: set `LALALAI_LICENSE_KEY` to
a [LALAL.AI](https://www.lalal.ai/api/v1/docs/) license key and the Split door
appears. The key stays on the server — the browser uploads to this server,
which talks to LALAL.AI and streams the finished stems back, so the page never
holds the key or addresses the split service. Uploads are capped at 30 MB, and
LALAL.AI bills per minute of audio processed.

## Deploying

Railway: point a service at this repo and add a Postgres database, then set the
service's `DATABASE_URL` to reference it (`${{Postgres.DATABASE_URL}}`).
`npm start` is the start command; `PORT` is supplied by the platform.

## Sound

Piano samples are from the FluidR3 GM soundfont (CC BY 3.0).
