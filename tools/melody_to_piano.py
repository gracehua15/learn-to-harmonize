#!/usr/bin/env python3
"""Render a POP909 MELODY track using this repo's piano samples.

POP909 ships each song as a 3-track MIDI (MELODY / BRIDGE / PIANO). This pulls
the MELODY track out and plays it back through the same voice engine the app
uses in the browser: nearest recorded sample, pitch-shifted by playback rate,
with a short attack ramp and a release at the note's end time.

    python3 tools/melody_to_piano.py path/to/POP909/001 -o melody.wav --json melody.json

Needs `pip install pretty_midi numpy soundfile` and ffmpeg on PATH (or the
imageio-ffmpeg package) to decode the mp3 samples.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

import numpy as np
import pretty_midi
import soundfile as sf

SR = 44100
NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

# Mirrors index.html: a 6ms ramp in so the attack doesn't click, and a 90ms
# fade at the note's end.
ATTACK = 0.006
RELEASE = 0.09


def ffmpeg_bin():
    exe = shutil.which('ffmpeg')
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit('ffmpeg not found — install it, or `pip install imageio-ffmpeg`')


def load_samples(sample_dir):
    """Decode samples/piano/*.mp3 to mono float32, keyed by MIDI number."""
    exe = ffmpeg_bin()
    samples = {}
    for name in sorted(os.listdir(sample_dir)):
        stem, ext = os.path.splitext(name)
        if ext != '.mp3' or stem[:-1] not in NOTE_NAMES:
            continue
        midi = 12 * (int(stem[-1]) + 1) + NOTE_NAMES.index(stem[:-1])
        raw = subprocess.run(
            [exe, '-v', 'quiet', '-i', os.path.join(sample_dir, name),
             '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'],
            check=True, stdout=subprocess.PIPE).stdout
        samples[midi] = np.frombuffer(raw, dtype='<f4').astype(np.float32)
    if not samples:
        sys.exit(f'no piano samples found in {sample_dir}')
    return samples


def render_note(samples, midi, duration, ring):
    """One voice: nearest sample resampled to pitch, enveloped to `duration`.

    `ring` lets the recording decay on its own past the note-off instead of
    being cut there. POP909 melodies are transcribed vocals: half the notes are
    under 0.15s and every one is followed by a gap, so honouring the note-offs
    literally gives a blippy, staccato line. A piano string keeps sounding after
    the key is struck, and letting it do so is what makes this read as piano.
    """
    # The samples are natural notes only, so every pitch is at most a semitone
    # from one of them — the shift never stretches far enough to sound wrong.
    src_midi = min(samples, key=lambda m: (abs(m - midi), m))
    src = samples[src_midi]
    rate = 2.0 ** ((midi - src_midi) / 12.0)

    if ring:
        # Play out the whole recording (~3.1s of decay), rate-adjusted.
        duration = max(duration, len(src) / rate / SR)
    length = int((duration + RELEASE) * SR)
    pos = np.arange(length) * rate
    keep = pos < len(src) - 1
    out = np.zeros(length, dtype=np.float32)
    # Linear interpolation, the same thing Web Audio's playbackRate does.
    idx = pos[keep].astype(np.int64)
    frac = (pos[keep] - idx).astype(np.float32)
    out[keep] = src[idx] * (1 - frac) + src[idx + 1] * frac

    env = np.ones(length, dtype=np.float32)
    a = min(int(ATTACK * SR), length)
    env[:a] = np.linspace(0, 1, a, dtype=np.float32)
    r = min(int(RELEASE * SR), length - a)
    if r > 0:
        rel_start = int(duration * SR)
        rel_start = min(max(rel_start, a), length - r)
        env[rel_start:rel_start + r] = np.linspace(1, 0, r, dtype=np.float32)
        env[rel_start + r:] = 0
    return out * env


def melody_notes(song_dir):
    song_id = os.path.basename(os.path.normpath(song_dir))
    path = os.path.join(song_dir, f'{song_id}.mid')
    if not os.path.exists(path):
        sys.exit(f'no {song_id}.mid in {song_dir}')
    pm = pretty_midi.PrettyMIDI(path)
    for inst in pm.instruments:
        # Match on the track name, not the index — that's what POP909 guarantees.
        if inst.name.strip().upper() == 'MELODY':
            return song_id, sorted(inst.notes, key=lambda n: n.start)
    sys.exit(f'{path} has no MELODY track')


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('song_dir', help='a POP909 song folder, e.g. POP909/001')
    ap.add_argument('-o', '--out', default='melody.wav', help='output wav')
    ap.add_argument('--json', dest='json_out', help='also write the note list as JSON')
    ap.add_argument('--samples', default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'samples', 'piano'))
    ap.add_argument('--start', type=float, default=0.0, help='trim start, seconds')
    ap.add_argument('--end', type=float, help='trim end, seconds')
    ap.add_argument('--transpose', type=int, default=0, help='semitones')
    ap.add_argument('--sustain', choices=('ring', 'next', 'note'), default='ring',
                    help='ring: let each note decay naturally (default, most '
                         'piano-like); next: hold until the next note starts; '
                         'note: cut at the note-off, as the app does for held keys')
    args = ap.parse_args()

    song_id, notes = melody_notes(args.song_dir)
    if args.end is not None:
        notes = [n for n in notes if n.start < args.end]
    notes = [n for n in notes if n.end > args.start]
    if not notes:
        sys.exit('no melody notes in that time range')

    # POP909 melodies start well into the track (song 001's first note is at
    # 12.7s); shift so the render opens on the first note.
    t0 = max(args.start, notes[0].start)
    samples = load_samples(args.samples)

    tail = max(n.end for n in notes) - t0 + 1.0
    buf = np.zeros(int(tail * SR) + SR, dtype=np.float32)
    events = []
    for i, n in enumerate(notes):
        start = max(n.start, args.start) - t0
        end = min(n.end, args.end) if args.end is not None else n.end
        if args.sustain == 'next' and i + 1 < len(notes):
            end = max(end, min(notes[i + 1].start, args.end or notes[i + 1].start))
        dur = end - t0 - start
        if dur <= 0:
            continue
        midi = n.pitch + args.transpose
        voice = render_note(samples, midi, dur, ring=args.sustain == 'ring')
        # Velocity as amplitude, softened — POP909 velocities sit in a narrow
        # band and mapping them straight makes everything the same loudness.
        gain = 0.35 + 0.65 * (n.velocity / 127.0)
        at = int(start * SR)
        if at + len(voice) > len(buf):
            buf = np.pad(buf, (0, at + len(voice) - len(buf)))
        buf[at:at + len(voice)] += voice * gain
        events.append({'time': round(start, 4), 'duration': round(dur, 4),
                       'midi': int(midi), 'velocity': int(n.velocity),
                       'name': pretty_midi.note_number_to_name(midi)})

    peak = float(np.max(np.abs(buf)))
    if peak > 0:
        buf *= 0.89 / peak  # the samples were never normalized; this brings it up
    sf.write(args.out, buf, SR)
    print(f'{song_id}: {len(events)} melody notes -> {args.out} '
          f'({len(buf) / SR:.1f}s, sustain={args.sustain}, {events[0]["name"]}..)')

    if args.json_out:
        with open(args.json_out, 'w') as fh:
            json.dump({'song': song_id, 'sourceOffset': round(t0, 4),
                       'notes': events}, fh, indent=1)
        print(f'   note list -> {args.json_out}')


if __name__ == '__main__':
    main()
