/** Tiny synthesized sounds so a hit, a block and getting hit each sound different. */
export function sfx(enabled: () => boolean) {
  let ctx: AudioContext | null = null;
  const ac = () => {
    if (!enabled()) return null;
    try {
      ctx ??= new AudioContext();
      return ctx;
    } catch {
      return null;
    }
  };

  function tone(freq: number, to: number, dur: number, type: OscillatorType, gain: number) {
    const c = ac();
    if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, c.currentTime);
    o.frequency.exponentialRampToValueAtTime(to, c.currentTime + dur);
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.connect(g).connect(c.destination);
    o.start();
    o.stop(c.currentTime + dur);
  }

  function noise(dur: number, freq: number, gain: number) {
    const c = ac();
    if (!c) return;
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = freq;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(c.destination);
    src.start();
  }

  return {
    cast: () => noise(0.18, 1800, 0.25),
    hit: () => {
      tone(220, 70, 0.18, "sine", 0.5);
      noise(0.08, 3000, 0.2);
    },
    block: () => tone(500, 380, 0.08, "square", 0.08),
    ouch: () => tone(140, 60, 0.25, "sawtooth", 0.18),
    flash: () => tone(900, 1800, 0.12, "triangle", 0.15),
    close: () => void ctx?.close().catch(() => undefined),
  };
}
