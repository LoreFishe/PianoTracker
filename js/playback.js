const ATTACK = 0.015;
const RELEASE = 0.08;
const GAIN = 0.18;

/** Minimal Web Audio synth for previewing a piece: schedules a triangle-wave
 * oscillator per note with a short attack/release envelope to avoid clicks.
 * Not meant to sound realistic — just enough to hear the melody and rhythm. */
export class Player {
  constructor() {
    this.audioContext = null;
    this.oscillators = [];
    this.endTimeoutId = null;
    this.isPlaying = false;
  }

  play(notes, { onEnd } = {}) {
    this.stop();
    if (notes.length === 0) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContextClass();
    this.isPlaying = true;

    const startAt = this.audioContext.currentTime + 0.15;
    let latestEnd = 0;

    for (const { midi, startSeconds, durationSeconds } of notes) {
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      const noteStart = startAt + startSeconds;
      const noteEnd = noteStart + Math.max(durationSeconds - 0.02, ATTACK + RELEASE);

      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(this.audioContext.destination);

      gain.gain.setValueAtTime(0, noteStart);
      gain.gain.linearRampToValueAtTime(GAIN, noteStart + ATTACK);
      gain.gain.setValueAtTime(GAIN, Math.max(noteEnd - RELEASE, noteStart + ATTACK));
      gain.gain.linearRampToValueAtTime(0, noteEnd);

      osc.start(noteStart);
      osc.stop(noteEnd + 0.02);
      this.oscillators.push(osc);

      latestEnd = Math.max(latestEnd, noteEnd);
    }

    const totalMs = (latestEnd - this.audioContext.currentTime + 0.2) * 1000;
    this.endTimeoutId = setTimeout(() => {
      this.isPlaying = false;
      onEnd?.();
    }, totalMs);
  }

  stop() {
    for (const osc of this.oscillators) {
      try {
        osc.stop();
      } catch {
        // already stopped
      }
    }
    this.oscillators = [];
    if (this.endTimeoutId) {
      clearTimeout(this.endTimeoutId);
      this.endTimeoutId = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.isPlaying = false;
  }
}
