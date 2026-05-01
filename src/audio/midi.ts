import { invoke } from "@tauri-apps/api/core";
import { Midi } from "@tonejs/midi";

export interface BassNote {
  /** MIDI pitch number (0-127). Bass typically lives in E1=28 .. G4=67. */
  pitch: number;
  /** Note start in seconds. */
  startSec: number;
  /** Note duration in seconds. */
  durSec: number;
  /** Normalised velocity 0..1. */
  velocity: number;
}

/** Fetch + parse `library/<id>/bass.mid` into a flat note list (sorted by start). */
export async function loadBassNotes(songId: string): Promise<BassNote[]> {
  const bytes = await invoke<ArrayBuffer>("read_midi", { songId });
  const midi = new Midi(bytes);
  const notes: BassNote[] = [];
  for (const track of midi.tracks) {
    for (const n of track.notes) {
      notes.push({
        pitch: n.midi,
        startSec: n.time,
        durSec: n.duration,
        velocity: n.velocity,
      });
    }
  }
  notes.sort((a, b) => a.startSec - b.startSec);
  return notes;
}
