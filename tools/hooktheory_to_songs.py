#!/usr/bin/env python3
"""Turn a lead-sheet-dataset event tree into the app's songs.json.

The Hooktheory/TheoryTab lead sheets ship one JSON per song section with a
labelled monophonic melody track — no extraction needed, unlike raw MIDI.
Get the data from https://github.com/wayne391/lead-sheet-dataset (the README
links the full archive), then point this at its datasets/event folder:

    python3 tools/hooktheory_to_songs.py path/to/datasets/event -o songs.json

Sections, not whole songs, are the unit here: a chorus hook is what you'd
actually want to sing a harmony against.
"""
import argparse
import glob
import json
import os
import re

# to_pianoroll.py in that repo renders melodies at octave_melody * 12, and its
# 'pitch' field is semitones relative to C. So a pitch of 0 is middle C.
MIDDLE_C = 60
NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

# Slugs are lowercased and hyphenated; restore something readable, keeping the
# short words that are conventionally capitalised in band names anyway.
def unslug(slug):
    words = [w for w in re.split(r'[-_]+', slug) if w]
    out = []
    for i, w in enumerate(words):
        if w.lower() in ('a', 'an', 'the', 'of', 'and', 'in', 'to') and i:
            out.append(w.lower())
        else:
            out.append(w[:1].upper() + w[1:])
    return ' '.join(out)


def note_name(midi):
    return f'{NOTE_NAMES[midi % 12]}{midi // 12 - 1}'


def read_section(path):
    with open(path) as fh:
        d = json.load(fh)
    meta = d.get('metadata', {})
    raw = d.get('tracks', {}).get('melody') or []
    try:
        bpm = float(meta.get('BPM') or 0)
    except ValueError:
        bpm = 0
    if bpm <= 0:
        return None
    beat = 60.0 / bpm

    notes = []
    for n in raw:
        # Rests come through as nulls, and as isRest entries.
        if not n or n.get('isRest'):
            continue
        midi = int(round(n['pitch'])) + MIDDLE_C
        start = float(n['event_on']) * beat
        dur = (float(n['event_off']) - float(n['event_on'])) * beat
        if dur <= 0:
            continue
        notes.append({'t': round(start, 3), 'd': round(dur, 3), 'midi': midi})
    if len(notes) < 4:
        return None

    lo = min(n['midi'] for n in notes)
    hi = max(n['midi'] for n in notes)
    # A transcription that never enters a singable register is no use here.
    if lo < 43 or hi > 88:
        return None

    parts = os.path.normpath(path).split(os.sep)
    # .../event/<letter>/<artist>/<song>/<section>_symbol_key.json
    section = re.sub(r'_symbol_key$', '', os.path.splitext(parts[-1])[0])
    return {
        'id': '/'.join(parts[-3:-1] + [section]),
        'title': meta.get('title') or unslug(parts[-2]),
        'artist': unslug(parts[-3]),
        'section': section,
        'key': meta.get('key', ''),
        'bpm': round(bpm),
        'range': f'{note_name(lo)}-{note_name(hi)}',
        'youtube': meta.get('YouTubeID', ''),
        'notes': notes,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('event_dir', help="the dataset's datasets/event folder")
    ap.add_argument('-o', '--out', default='songs.json')
    ap.add_argument('--limit', type=int, help='keep only the first N sections')
    args = ap.parse_args()

    paths = sorted(glob.glob(os.path.join(args.event_dir, '**', '*_symbol_key.json'),
                             recursive=True))
    if not paths:
        raise SystemExit(f'no *_symbol_key.json found under {args.event_dir}')

    songs, skipped = [], 0
    for p in paths:
        try:
            s = read_section(p)
        except (KeyError, ValueError, TypeError):
            s = None
        if s:
            songs.append(s)
        else:
            skipped += 1
        if args.limit and len(songs) >= args.limit:
            break

    songs.sort(key=lambda s: (s['artist'].lower(), s['title'].lower(), s['section']))
    with open(args.out, 'w') as fh:
        json.dump({'songs': songs}, fh, separators=(',', ':'))
    print(f'{len(songs)} playable sections -> {args.out} '
          f'({skipped} skipped: no melody, too short, or out of range)')


if __name__ == '__main__':
    main()
