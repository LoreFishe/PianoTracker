const ATTACK = 0.015;
const RELEASE = 0.08;
const GAIN = 0.18;
const DRONE_FADE = 0.12;

/** Minimal Web Audio synth for previewing a piece: schedules a triangle-wave
 * oscillator per note with a short attack/release envelope to avoid clicks.
 * Not meant to sound realistic — just enough to hear the melody and rhythm. */
export class Player {
  constructor() {
    this.audioContext = null;
    this.oscillators = [];
    this.endTimeoutId = null;
    this.isPlaying = false;

    // Entirely separate from the fields above: play()/stop() close their
    // AudioContext outright between previews, which would kill a drone if
    // it shared that context. The drone gets its own, kept open for as long
    // as it's sounding.
    this.droneContext = null;
    this.droneOscillator = null;
    this.droneGain = null;
    this.droneVolume = 0.35;
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

  get droneActive() {
    return this.droneOscillator !== null;
  }

  /** Starts (or re-pitches, if already running) a sustained triangle-wave
   * tone at `midi` — for practicing/improvising against a fixed tonic.
   * Re-pitching an already-running drone just changes frequency, no
   * restart/click, so it can track a transpose change live. */
  startDrone(midi) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    if (this.droneOscillator) {
      this.droneOscillator.frequency.setTargetAtTime(freq, this.droneContext.currentTime, 0.05);
      return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.droneContext = new AudioContextClass();
    const osc = this.droneContext.createOscillator();
    const gain = this.droneContext.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(this.droneContext.destination);

    gain.gain.setValueAtTime(0, this.droneContext.currentTime);
    gain.gain.linearRampToValueAtTime(this.droneVolume, this.droneContext.currentTime + DRONE_FADE);

    osc.start();
    this.droneOscillator = osc;
    this.droneGain = gain;
  }

  stopDrone() {
    if (!this.droneOscillator) return;
    const ctx = this.droneContext;
    const osc = this.droneOscillator;
    const gain = this.droneGain;
    gain.gain.setTargetAtTime(0, ctx.currentTime, DRONE_FADE / 3);
    setTimeout(() => {
      try {
        osc.stop();
      } catch {
        // already stopped
      }
      ctx.close();
    }, DRONE_FADE * 1000 + 50);

    this.droneContext = null;
    this.droneOscillator = null;
    this.droneGain = null;
  }

  setDroneVolume(volume) {
    this.droneVolume = volume;
    if (this.droneGain) {
      this.droneGain.gain.setTargetAtTime(volume, this.droneContext.currentTime, 0.05);
    }
  }
}
