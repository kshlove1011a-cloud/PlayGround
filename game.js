(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const $ = (selector) => document.querySelector(selector);
  const TAU = Math.PI * 2;
  const clamp = (value, min, max) => value < min ? min : value > max ? max : value;
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const nowSeconds = () => performance.now() / 1000;
  const padScore = (value) => String(Math.max(0, Math.floor(value))).padStart(6, '0');
  const rgba = (hex, alpha) => {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  };

  // Deterministic pseudo-random values keep the chart and scenery stable.
  let rngState = 0x4e454f4e;
  function rng() {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 4294967296;
  }

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------

  const canvas = $('#game');
  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
  const bgLayer = $('#bgLayer');
  const bgCtx = bgLayer.getContext('2d', { alpha: false, desynchronized: true });

  const ui = {
    wrap: $('#gameWrap'),
    hud: $('#hud'),
    title: $('#titleScreen'),
    playBtn: $('#playBtn'),
    playLabel: $('#playLabel'),
    bestScore: $('#bestScore'),
    score: $('#score'),
    shields: [...document.querySelectorAll('#shields i')],
    progress: $('#progressFill'),
    timeLeft: $('#timeLeft'),
    accuracy: $('#accuracy'),
    comboWrap: $('#comboWrap'),
    combo: $('#combo'),
    muteBtn: $('#muteBtn'),
    muteIcon: $('#muteIcon'),
    pauseBtn: $('#pauseBtn'),
    countdown: $('#countdown'),
    countdownText: $('#countdownText'),
    pauseScreen: $('#pauseScreen'),
    resumeBtn: $('#resumeBtn'),
    quitBtn: $('#quitBtn'),
    resultScreen: $('#resultScreen'),
    resultKicker: $('#resultKicker'),
    resultRank: $('#resultRank'),
    resultTitle: $('#resultTitle'),
    finalScore: $('#finalScore'),
    statPerfect: $('#statPerfect'),
    statGreat: $('#statGreat'),
    statGood: $('#statGood'),
    statMiss: $('#statMiss'),
    statCombo: $('#statCombo'),
    statAccuracy: $('#statAccuracy'),
    newBest: $('#newBest'),
    replayBtn: $('#replayBtn'),
    homeBtn: $('#homeBtn'),
    toast: $('#toast'),
    screenEdge: $('#screenEdge'),
  };

  // ---------------------------------------------------------------------------
  // Game constants
  // ---------------------------------------------------------------------------

  const BPM = 120;
  const BEAT = 60 / BPM;
  const SONG_BEATS = 96;
  const SONG_DURATION = SONG_BEATS * BEAT;
  const TRAVEL_TIME = 2.05;
  const MAX_HEALTH = 5;
  const HIT_WINDOW = { perfect: 0.055, great: 0.105, good: 0.17, early: 0.34 };
  const STORAGE_BEST = 'neoncut.best.v1';
  const STORAGE_MUTE = 'neoncut.muted.v1';

  const TYPES = {
    grunt: { color: '#47f7ff', rgb: '71,247,255', scale: 1.0, score: 1 },
    elite: { color: '#ff4fd8', rgb: '255,79,216', scale: 1.07, score: 1.35 },
    gold: { color: '#ffd166', rgb: '255,209,102', scale: 0.94, score: 2.0 },
  };

  const CHART = buildChart();

  function buildChart() {
    const notes = [];
    const range = (from, to, step) => {
      for (let beat = from; beat <= to; beat += step) notes.push({ beat, type: 'grunt' });
    };

    range(8, 14, 2);
    range(16, 30, 2);
    range(32, 39, 1);
    range(40, 54, 2);
    range(56, 71, 1);
    range(72, 78, 2);
    range(80, 87, 1);

    const specials = new Map([
      [32, 'gold'], [44, 'elite'], [56, 'elite'], [60, 'elite'],
      [64, 'gold'], [76, 'elite'], [80, 'gold'],
    ]);

    return notes.map((note) => {
      const type = specials.get(note.beat) || note.type;
      return {
        hitTime: note.beat * BEAT,
        type,
        curve: (rng() * 2 - 1) * 1.15,
        seed: rng(),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Runtime state
  // ---------------------------------------------------------------------------

  let state = 'title';
  let W = 1;
  let H = 1;
  let DPR = 1;
  // Start sharp on fast phones, then step down only if real frame times say the
  // device cannot keep up. A fixed high DPR is the main source of mobile lag.
  const MAX_DPR = clamp(window.devicePixelRatio || 1, 1, 1.5);
  let dprCap = MAX_DPR;
  let autoDpr = true;
  let qualityTime = 0;
  let qualityFrames = 0;
  let qualityWarmup = 0.9;
  let cx = 0;
  let horizonY = 0;
  let strikeY = 0;
  let strikeR = 80;
  let lastNow = nowSeconds();
  let runId = 0;
  let dying = false;
  let failAt = 0;

  let enemies = [];
  let score = 0;
  let combo = 0;
  let maxCombo = 0;
  let health = MAX_HEALTH;
  let judged = 0;
  let perfectCount = 0;
  let greatCount = 0;
  let goodCount = 0;
  let missCount = 0;
  let accuracyPoints = 0;
  let nextHealCombo = 20;
  let nearestTarget = null;
  let reticleFlash = 0;
  let shake = 0;
  let flash = 0;
  let flashColor = '255,255,255';
  let countdownValue = '';
  let toastTimer = 0;
  let lowHealthState = false;
  const renderFlags = {
    background: true, stars: true, grid: true, gates: true,
    embers: true, reticle: true, enemies: true, effects: true,
  };

  // ---------------------------------------------------------------------------
  // Canvas scenery state
  // ---------------------------------------------------------------------------

  let bgCanvas = null;
  let stars = [];
  let embers = [];
  let horizonGlow = null;
  let cutLineGrad = null;
  let sprites = {};

  // Effect pools keep the hot loop allocation-free.
  const particles = Array.from({ length: 260 }, () => ({
    life: 0, maxLife: 1, x: 0, y: 0, vx: 0, vy: 0, size: 2, color: '#fff', rgb: '255,255,255', shard: false, spin: 0, angle: 0,
  }));
  const waves = Array.from({ length: 18 }, () => ({
    life: 0, maxLife: 1, x: 0, y: 0, r: 0, speed: 0, color: '#fff', rgb: '255,255,255',
  }));
  const texts = Array.from({ length: 24 }, () => ({
    life: 0, maxLife: 1, x: 0, y: 0, text: '', color: '#fff', size: 20, vy: 40,
  }));
  const slashes = Array.from({ length: 16 }, () => ({
    life: 0, maxLife: 1, x: 0, y: 0, r: 70, angle: 0, color: '#fff', rgb: '255,255,255',
  }));

  // ---------------------------------------------------------------------------
  // Audio: a fully rendered synthwave track keeps timing rock solid on phones
  // ---------------------------------------------------------------------------

  let audioCtx = null;
  let masterGain = null;
  let musicGain = null;
  let songBuffer = null;
  let musicSource = null;
  let sfxBuffers = {};
  let audioStartTime = 0;
  let useAudio = false;
  let preparingPromise = null;
  let lastPrepareMs = 0;
  let fallbackStart = 0;
  let fallbackPausedAt = 0;
  let muted = false;

  try {
    muted = localStorage.getItem(STORAGE_MUTE) === '1';
  } catch (_) { /* storage can be unavailable in private mode */ }

  function makeNoiseBuffer(ac, seconds = 2) {
    const length = Math.floor(ac.sampleRate * seconds);
    const buffer = ac.createBuffer(1, length, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  function makeImpulse(ac, seconds = 2.1, decay = 2.7) {
    const length = Math.floor(ac.sampleRate * seconds);
    const buffer = ac.createBuffer(2, length, ac.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return buffer;
  }

  function makeSfxBuffer(ac, kind) {
    const durations = { perfect: 0.3, great: 0.26, good: 0.2, miss: 0.34, early: 0.16, ui: 0.11, gold: 0.46 };
    const duration = durations[kind] || 0.2;
    const length = Math.ceil(ac.sampleRate * duration);
    const buffer = ac.createBuffer(1, length, ac.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < length; i++) {
      const t = i / ac.sampleRate;
      let value = 0;

      if (kind === 'perfect') {
        value =
          Math.sin(TAU * 1318.5 * t) * 0.32 * Math.exp(-t * 10) +
          Math.sin(TAU * 1975.5 * t) * 0.17 * Math.exp(-t * 16) +
          Math.sin(TAU * 659.25 * t) * 0.2 * Math.exp(-t * 8) +
          (Math.random() * 2 - 1) * 0.22 * Math.exp(-t * 45);
      } else if (kind === 'great') {
        value =
          Math.sin(TAU * 987.8 * t) * 0.28 * Math.exp(-t * 13) +
          Math.sin(TAU * 1479.9 * t) * 0.1 * Math.exp(-t * 19) +
          (Math.random() * 2 - 1) * 0.18 * Math.exp(-t * 48);
      } else if (kind === 'good') {
        value =
          Math.sin(TAU * 740 * t) * 0.24 * Math.exp(-t * 18) +
          (Math.random() * 2 - 1) * 0.1 * Math.exp(-t * 55);
      } else if (kind === 'gold') {
        const notes = [1046.5, 1318.5, 1568, 2093];
        const note = notes[Math.min(notes.length - 1, Math.floor(t / 0.09))];
        value =
          Math.sin(TAU * note * t) * 0.25 * Math.exp(-(t % 0.09) * 22) +
          Math.sin(TAU * note * 2 * t) * 0.08 * Math.exp(-t * 9);
      } else if (kind === 'miss') {
        value =
          Math.sin(TAU * (92 - t * 120) * t) * 0.36 * Math.exp(-t * 7) +
          (Math.random() * 2 - 1) * 0.16 * Math.exp(-t * 18);
      } else if (kind === 'early') {
        value = Math.sin(TAU * 210 * t) * 0.15 * Math.exp(-t * 32);
      } else if (kind === 'ui') {
        value = Math.sin(TAU * 1200 * t) * 0.13 * Math.exp(-t * 38);
      }

      data[i] = clamp(value, -1, 1);
    }

    return buffer;
  }

  function makeSfx(ac) {
    const result = {};
    for (const kind of ['perfect', 'great', 'good', 'gold', 'miss', 'early', 'ui']) {
      result[kind] = makeSfxBuffer(ac, kind);
    }
    return result;
  }

  function buildTrack(ac) {
    const noise = makeNoiseBuffer(ac, 2);
    const master = ac.createGain();
    master.gain.value = 0.68;
    master.gain.setValueAtTime(0.68, SONG_DURATION - 2);
    master.gain.linearRampToValueAtTime(0.0001, SONG_DURATION);

    const compressor = ac.createDynamicsCompressor();
    compressor.threshold.value = -17;
    compressor.knee.value = 18;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;
    master.connect(compressor);
    compressor.connect(ac.destination);

    const music = ac.createGain();
    music.gain.value = 0.9;
    music.connect(master);

    // A short filtered feedback line gives the mix space without the offline
    // rendering cost of a long convolution reverb (important on phones).
    const space = ac.createDelay(0.5);
    space.delayTime.value = 0.17;
    const spaceFilter = ac.createBiquadFilter();
    spaceFilter.type = 'lowpass';
    spaceFilter.frequency.value = 2600;
    const spaceFeedback = ac.createGain();
    spaceFeedback.gain.value = 0.3;
    const spaceReturn = ac.createGain();
    spaceReturn.gain.value = 0.2;
    space.connect(spaceFilter);
    spaceFilter.connect(spaceFeedback);
    spaceFeedback.connect(space);
    spaceFilter.connect(spaceReturn);
    spaceReturn.connect(master);

    const delay = ac.createDelay(1);
    delay.delayTime.value = BEAT * 0.75;
    const delayFeedback = ac.createGain();
    delayFeedback.gain.value = 0.26;
    const delayReturn = ac.createGain();
    delayReturn.gain.value = 0.16;
    delay.connect(delayFeedback);
    delayFeedback.connect(delay);
    delay.connect(delayReturn);
    delayReturn.connect(master);

    const delaySend = ac.createGain();
    delaySend.gain.value = 0.22;
    delaySend.connect(delay);

    const noiseBurst = (time, duration, type, frequency, q, volume, destination, sweepTo = 0) => {
      const source = ac.createBufferSource();
      source.buffer = noise;
      source.loop = true;
      const filter = ac.createBiquadFilter();
      filter.type = type;
      filter.frequency.setValueAtTime(frequency, time);
      if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, time + duration);
      filter.Q.value = q;
      const gain = ac.createGain();
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), time + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(destination);
      source.start(time, Math.random() * 0.4);
      source.stop(time + duration + 0.03);
    };

    const kick = (time, volume = 1) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(168, time);
      osc.frequency.exponentialRampToValueAtTime(43, time + 0.115);
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(0.9 * volume, time + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.29);
      osc.connect(gain);
      gain.connect(music);
      osc.start(time);
      osc.stop(time + 0.31);
      noiseBurst(time, 0.035, 'highpass', 2300, 0.8, 0.08 * volume, music);
    };

    const snare = (time, volume = 1) => {
      noiseBurst(time, 0.19, 'bandpass', 1850, 1.2, 0.3 * volume, music);
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(185, time);
      osc.frequency.exponentialRampToValueAtTime(95, time + 0.1);
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(0.2 * volume, time + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.14);
      osc.connect(gain);
      gain.connect(music);
      osc.start(time);
      osc.stop(time + 0.16);
    };

    const hat = (time, volume = 1, open = false) => {
      noiseBurst(time, open ? 0.18 : 0.045, 'highpass', open ? 6200 : 7800, 0.8, (open ? 0.075 : 0.055) * volume, music);
    };

    const bass = (time, frequency, duration, volume = 1) => {
      const saw = ac.createOscillator();
      const sub = ac.createOscillator();
      const filter = ac.createBiquadFilter();
      const gain = ac.createGain();
      saw.type = 'sawtooth';
      sub.type = 'sine';
      saw.frequency.value = frequency;
      sub.frequency.value = frequency * 0.5;
      filter.type = 'lowpass';
      filter.Q.value = 5;
      filter.frequency.setValueAtTime(980, time);
      filter.frequency.exponentialRampToValueAtTime(230, time + duration);
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(0.16 * volume, time + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
      saw.connect(filter);
      sub.connect(filter);
      filter.connect(gain);
      gain.connect(music);
      saw.start(time);
      sub.start(time);
      saw.stop(time + duration + 0.02);
      sub.stop(time + duration + 0.02);
    };

    const pluck = (time, frequency, duration, volume, pan) => {
      const osc = ac.createOscillator();
      const shimmer = ac.createOscillator();
      const filter = ac.createBiquadFilter();
      const gain = ac.createGain();
      const panner = ac.createStereoPanner();
      const spaceSend = ac.createGain();
      osc.type = 'triangle';
      shimmer.type = 'square';
      osc.frequency.value = frequency;
      shimmer.frequency.value = frequency * 2;
      shimmer.detune.value = 4;
      filter.type = 'lowpass';
      filter.Q.value = 2;
      filter.frequency.setValueAtTime(5200, time);
      filter.frequency.exponentialRampToValueAtTime(1300, time + duration);
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(volume, time + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
      panner.pan.value = pan;
      spaceSend.gain.value = 0.5;
      osc.connect(filter);
      shimmer.connect(filter);
      filter.connect(gain);
      gain.connect(panner);
      panner.connect(music);
      panner.connect(delaySend);
      panner.connect(spaceSend);
      spaceSend.connect(space);
      osc.start(time);
      shimmer.start(time);
      osc.stop(time + duration + 0.03);
      shimmer.stop(time + duration + 0.03);
    };

    const pad = (time, frequencies, duration, volume) => {
      const filter = ac.createBiquadFilter();
      const gain = ac.createGain();
      const spaceSend = ac.createGain();
      filter.type = 'lowpass';
      filter.frequency.value = 860;
      filter.Q.value = 1.2;
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.linearRampToValueAtTime(volume, time + 0.32);
      gain.gain.setValueAtTime(volume, time + duration - 0.35);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
      spaceSend.gain.value = 0.75;
      for (const frequency of frequencies) {
        for (const detune of [-7, 7]) {
          const osc = ac.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.value = frequency;
          osc.detune.value = detune;
          osc.connect(filter);
          osc.start(time);
          osc.stop(time + duration + 0.05);
        }
      }
      filter.connect(gain);
      gain.connect(music);
      gain.connect(spaceSend);
      spaceSend.connect(space);
    };

    const riser = (time, duration, volume = 1) => {
      noiseBurst(time, duration, 'bandpass', 320, 1.4, 0.075 * volume, music, 7200);
    };

    const chords = [
      { root: 110.0, notes: [220.0, 261.63, 329.63] },
      { root: 87.31, notes: [174.61, 220.0, 261.63] },
      { root: 130.81, notes: [261.63, 329.63, 392.0] },
      { root: 98.0, notes: [196.0, 246.94, 293.66] },
    ];
    const bassPattern = [0, 0, 12, 0, 7, 0, 10, 7];

    for (let bar = 0; bar < 24; bar++) {
      const chord = chords[bar % 4];
      const barStart = bar * 4 * BEAT;
      const intro = bar < 2;
      const breakdown = bar >= 10 && bar < 14;
      const chorus = bar >= 14 && bar < 22;
      const outro = bar >= 22;

      pad(barStart, chord.notes, 4 * BEAT * 0.98, intro ? 0.025 : breakdown ? 0.022 : 0.018);

      const sixteenth = (bar >= 6 && bar < 10) || chorus;
      const step = sixteenth ? BEAT / 4 : BEAT / 2;
      const count = Math.round((4 * BEAT) / step);
      for (let i = 0; i < count; i++) {
        const note = chord.notes[(i * 2 + bar) % 3];
        const octave = sixteenth && i % 8 === 6 ? 2 : 1;
        const pan = ((i % 4) - 1.5) * 0.32;
        pluck(
          barStart + i * step,
          note * octave,
          step * (sixteenth ? 2.1 : 1.8),
          (chorus ? 0.034 : 0.027) * (outro ? 0.72 : 1),
          pan,
        );
      }

      if (!intro && !outro) {
        const fourOnFloor = bar >= 6;
        for (let beat = 0; beat < 4; beat++) {
          if (fourOnFloor || beat % 2 === 0) kick(barStart + beat * BEAT, fourOnFloor ? 1 : 0.78);
        }
        snare(barStart + BEAT, 0.9);
        snare(barStart + 3 * BEAT, 0.95);
        if (chorus || (bar >= 6 && bar < 10)) {
          for (let i = 0; i < 8; i++) hat(barStart + i * BEAT / 2, i % 2 === 0 ? 0.75 : 1);
        } else {
          for (let i = 0; i < 4; i++) hat(barStart + i * BEAT + BEAT / 2, 1);
        }
        if (chorus) hat(barStart + 3.5 * BEAT, 1.15, true);

        for (let i = 0; i < 8; i++) {
          const semitone = bassPattern[i];
          const frequency = chord.root * Math.pow(2, semitone / 12);
          bass(barStart + i * BEAT / 2, frequency, BEAT * 0.4, chorus ? 1.08 : 0.92);
        }
      }

      if (bar === 2 || bar === 6 || bar === 10 || bar === 14) {
        riser(barStart - BEAT * 0.6, BEAT * 0.6, bar === 14 ? 1.25 : 0.85);
      }
      if (bar === 6 || bar === 14) {
        noiseBurst(barStart, 0.8, 'highpass', 5200, 0.7, 0.12, music);
      }
    }

    // A final low hit gives the last beat a satisfying full stop.
    kick(88 * BEAT, 1.2);
    bass(88 * BEAT, 55, 1.1, 0.75);
    noiseBurst(88 * BEAT, 0.6, 'highpass', 4200, 0.6, 0.08, music);
  }

  // Render the track directly into a stereo buffer. This is dramatically
  // faster and more predictable than a long OfflineAudioContext render, so the
  // first tap never leaves a phone sitting on a loading screen.
  function renderSongBuffer(ac) {
    const sampleRate = Math.min(24000, ac.sampleRate || 44100);
    const length = Math.ceil((SONG_DURATION + 0.4) * sampleRate);
    const buffer = ac.createBuffer(2, length, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    const noiseLength = 65536;
    const noise = new Float32Array(noiseLength);
    let noiseState = 0x9e3779b9;
    for (let i = 0; i < noiseLength; i++) {
      noiseState ^= noiseState << 13;
      noiseState ^= noiseState >>> 17;
      noiseState ^= noiseState << 5;
      noise[i] = (noiseState >>> 0) / 2147483648 - 1;
    }

    const panGain = (pan) => {
      const angle = (clamp(pan, -1, 1) + 1) * Math.PI * 0.25;
      return [Math.cos(angle), Math.sin(angle)];
    };

    const add = (index, value, gainL, gainR) => {
      if (index < 0 || index >= length) return;
      left[index] += value * gainL;
      right[index] += value * gainR;
    };

    const kick = (time, volume = 1) => {
      const start = Math.round(time * sampleRate);
      const duration = Math.floor(0.32 * sampleRate);
      let phase = 0;
      for (let i = 0; i < duration; i++) {
        const u = i / sampleRate;
        const frequency = 43 + 138 * Math.exp(-u * 31);
        phase += TAU * frequency / sampleRate;
        const envelope = Math.exp(-u * 10.5);
        const click = noise[(start + i) & (noiseLength - 1)] * Math.exp(-u * 82) * 0.13;
        add(start + i, (Math.sin(phase) * 0.84 + click) * envelope * volume, 0.707, 0.707);
      }
    };

    const snare = (time, volume = 1) => {
      const start = Math.round(time * sampleRate);
      const duration = Math.floor(0.22 * sampleRate);
      for (let i = 0; i < duration; i++) {
        const u = i / sampleRate;
        const n = (start + i) & (noiseLength - 1);
        const high = noise[n] - noise[(n - 1) & (noiseLength - 1)];
        const tone = Math.sin(TAU * 176 * u);
        const envelope = Math.exp(-u * 15);
        add(start + i, (high * 0.24 + tone * 0.22) * envelope * volume, 0.68, 0.72);
      }
    };

    const hat = (time, volume = 1, open = false) => {
      const start = Math.round(time * sampleRate);
      const duration = Math.floor((open ? 0.17 : 0.05) * sampleRate);
      for (let i = 0; i < duration; i++) {
        const u = i / sampleRate;
        const n = (start + i) & (noiseLength - 1);
        const high = noise[n] - noise[(n - 1) & (noiseLength - 1)];
        const envelope = Math.exp(-u * (open ? 19 : 76));
        add(start + i, high * envelope * 0.1 * volume, 0.78, 0.5);
      }
    };

    const bass = (time, frequency, duration, volume = 1) => {
      const start = Math.round(time * sampleRate);
      const samples = Math.floor(duration * sampleRate);
      const cutoff = 1 - Math.exp(-TAU * 640 / sampleRate);
      let phase = 0;
      let subPhase = 0;
      let low = 0;
      for (let i = 0; i < samples; i++) {
        const u = i / sampleRate;
        const saw = 2 * (phase / TAU - Math.floor(phase / TAU + 0.5));
        const sub = Math.sin(subPhase);
        low += (saw - low) * cutoff;
        const attack = Math.min(1, u / 0.008);
        const release = Math.min(1, (duration - u) / 0.045);
        const envelope = attack * release * Math.exp(-u * 2.1);
        add(start + i, (low * 0.62 + sub * 0.38) * envelope * 0.34 * volume, 0.707, 0.707);
        phase += TAU * frequency / sampleRate;
        subPhase += TAU * (frequency * 0.5) / sampleRate;
      }
    };

    const pluck = (time, frequency, duration, volume, pan) => {
      const start = Math.round(time * sampleRate);
      const samples = Math.floor(duration * sampleRate);
      const [gainL, gainR] = panGain(pan);
      let phase = 0;
      let shimmerPhase = 0;
      for (let i = 0; i < samples; i++) {
        const u = i / sampleRate;
        const triangle = 2 * Math.abs(2 * (phase / TAU - Math.floor(phase / TAU + 0.5))) - 1;
        const shimmer = Math.sin(shimmerPhase) > 0 ? 1 : -1;
        const attack = 1 - Math.exp(-u * 240);
        const envelope = attack * Math.exp(-u * 7.2);
        add(start + i, (triangle * 0.76 + shimmer * 0.15) * envelope * 0.18 * volume, gainL, gainR);
        phase += TAU * frequency / sampleRate;
        shimmerPhase += TAU * frequency * 2 / sampleRate;
      }
    };

    const pad = (time, frequencies, duration, volume) => {
      const start = Math.round(time * sampleRate);
      const samples = Math.floor(duration * sampleRate);
      for (let f = 0; f < frequencies.length; f++) {
        for (const detune of [-6, 6]) {
          const frequency = frequencies[f] * Math.pow(2, detune / 1200);
          const [gainL, gainR] = panGain((f - 1) * 0.34);
          let phase = 0;
          let low = 0;
          const cutoff = 1 - Math.exp(-TAU * 760 / sampleRate);
          for (let i = 0; i < samples; i++) {
            const u = i / sampleRate;
            const saw = 2 * (phase / TAU - Math.floor(phase / TAU + 0.5));
            low += (saw - low) * cutoff;
            const attack = Math.min(1, u / 0.38);
            const release = Math.min(1, (duration - u) / 0.5);
            const envelope = attack * release;
            add(start + i, low * envelope * 0.052 * volume, gainL, gainR);
            phase += TAU * frequency / sampleRate;
          }
        }
      }
    };

    const riser = (time, duration, volume = 1) => {
      const start = Math.round(time * sampleRate);
      const samples = Math.floor(duration * sampleRate);
      for (let i = 0; i < samples; i++) {
        const u = i / sampleRate;
        const p = u / duration;
        const n = (start + i) & (noiseLength - 1);
        const high = noise[n] - noise[(n - 1) & (noiseLength - 1)];
        const envelope = Math.pow(p, 2.2) * (1 - p * 0.2);
        add(start + i, high * envelope * 0.16 * volume, 0.7, 0.7);
      }
    };

    const crash = (time, volume = 1) => {
      const start = Math.round(time * sampleRate);
      const samples = Math.floor(0.9 * sampleRate);
      for (let i = 0; i < samples; i++) {
        const u = i / sampleRate;
        const n = (start + i) & (noiseLength - 1);
        const high = noise[n] - noise[(n - 1) & (noiseLength - 1)];
        add(start + i, high * Math.exp(-u * 4.5) * 0.11 * volume, 0.75, 0.55);
      }
    };

    const chords = [
      { root: 110.0, notes: [220.0, 261.63, 329.63] },
      { root: 87.31, notes: [174.61, 220.0, 261.63] },
      { root: 130.81, notes: [261.63, 329.63, 392.0] },
      { root: 98.0, notes: [196.0, 246.94, 293.66] },
    ];
    const bassPattern = [0, 0, 12, 0, 7, 0, 10, 7];

    for (let bar = 0; bar < 24; bar++) {
      const chord = chords[bar % 4];
      const barStart = bar * 4 * BEAT;
      const intro = bar < 2;
      const chorus = bar >= 14 && bar < 22;
      const outro = bar >= 22;

      pad(barStart, chord.notes, 4 * BEAT * 0.99, intro ? 1.3 : chorus ? 1 : 0.85);

      const sixteenth = (bar >= 6 && bar < 10) || chorus;
      const step = sixteenth ? BEAT / 4 : BEAT / 2;
      const count = Math.round((4 * BEAT) / step);
      for (let i = 0; i < count; i++) {
        const note = chord.notes[(i * 2 + bar) % 3];
        const octave = sixteenth && i % 8 === 6 ? 2 : 1;
        const pan = ((i % 4) - 1.5) * 0.38;
        const volume = (chorus ? 1.22 : 1) * (outro ? 0.7 : 1);
        pluck(barStart + i * step, note * octave, step * 2.15, volume, pan);
        pluck(barStart + i * step + BEAT * 0.75, note * octave, step * 1.4, volume * 0.22, -pan);
      }

      if (!intro && !outro) {
        const fourOnFloor = bar >= 6;
        for (let beat = 0; beat < 4; beat++) {
          if (fourOnFloor || beat % 2 === 0) kick(barStart + beat * BEAT, fourOnFloor ? 1 : 0.82);
        }
        snare(barStart + BEAT, 0.95);
        snare(barStart + 3 * BEAT, 1);
        if (chorus || (bar >= 6 && bar < 10)) {
          for (let i = 0; i < 8; i++) hat(barStart + i * BEAT / 2, i % 2 === 0 ? 0.72 : 1);
        } else {
          for (let i = 0; i < 4; i++) hat(barStart + i * BEAT + BEAT / 2, 1);
        }
        if (chorus) hat(barStart + 3.5 * BEAT, 1.2, true);

        for (let i = 0; i < 8; i++) {
          const frequency = chord.root * Math.pow(2, bassPattern[i] / 12);
          bass(barStart + i * BEAT / 2, frequency, BEAT * 0.41, chorus ? 1.1 : 0.92);
        }
      }

      if (bar === 2 || bar === 6 || bar === 10 || bar === 14) riser(barStart - BEAT * 0.62, BEAT * 0.62, bar === 14 ? 1.3 : 0.9);
      if (bar === 6 || bar === 14) crash(barStart, 1);
    }

    kick(88 * BEAT, 1.3);
    bass(88 * BEAT, 55, 1.2, 0.8);
    crash(88 * BEAT, 0.8);

    let peak = 0;
    for (let i = 0; i < length; i++) {
      const l = Math.abs(left[i]);
      const r = Math.abs(right[i]);
      if (l > peak) peak = l;
      if (r > peak) peak = r;
    }
    const gain = peak > 0.0001 ? Math.min(2.4, 0.84 / peak) : 1;
    const fadeStart = Math.floor((SONG_DURATION - 2) * sampleRate);
    for (let i = 0; i < length; i++) {
      const fade = i > fadeStart ? Math.max(0, (length - i) / (length - fadeStart)) : 1;
      let l = left[i] * gain * fade;
      let r = right[i] * gain * fade;
      if (l > 1) l = 1; else if (l < -1) l = -1;
      if (r > 1) r = 1; else if (r < -1) r = -1;
      left[i] = l;
      right[i] = r;
    }

    return buffer;
  }

  function prepareSong() {
    if (songBuffer) return;
    if (!audioCtx) throw new Error('AudioContext unavailable');
    const startedAt = performance.now();
    songBuffer = renderSongBuffer(audioCtx);
    lastPrepareMs = Math.round(performance.now() - startedAt);
  }

  async function ensureAudio() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return false;
    try {
      if (!audioCtx) {
        audioCtx = new AudioCtor({ latencyHint: 'interactive' });
        masterGain = audioCtx.createGain();
        masterGain.gain.value = muted ? 0 : 0.9;
        masterGain.connect(audioCtx.destination);
        musicGain = audioCtx.createGain();
        musicGain.gain.value = 0.86;
        musicGain.connect(masterGain);
        sfxBuffers = makeSfx(audioCtx);
      }
      if (audioCtx.state !== 'running') await audioCtx.resume();
      return true;
    } catch (error) {
      console.warn('Audio unavailable, running silently.', error);
      return false;
    }
  }

  function setMuted(next) {
    muted = next;
    try { localStorage.setItem(STORAGE_MUTE, muted ? '1' : '0'); } catch (_) { /* ignore */ }
    if (masterGain && audioCtx) {
      masterGain.gain.setTargetAtTime(muted ? 0 : 0.9, audioCtx.currentTime, 0.02);
    }
    ui.muteIcon.textContent = muted ? '×' : '♪';
    ui.muteBtn.setAttribute('aria-label', muted ? '소리 켜기' : '소리 끄기');
    ui.muteBtn.title = muted ? '소리 켜기' : '소리 끄기';
  }

  function playSfx(name, pitch = 1) {
    if (!audioCtx || !sfxBuffers[name] || audioCtx.state !== 'running') return;
    const source = audioCtx.createBufferSource();
    const gain = audioCtx.createGain();
    source.buffer = sfxBuffers[name];
    source.playbackRate.value = pitch;
    gain.gain.value = 0.62;
    source.connect(gain);
    gain.connect(masterGain);
    source.start();
  }

  function beginTimeline() {
    if (useAudio && audioCtx && songBuffer) {
      if (musicGain) {
        musicGain.gain.cancelScheduledValues(audioCtx.currentTime);
        musicGain.gain.setValueAtTime(0.86, audioCtx.currentTime);
      }
      const latency = clamp(audioCtx.outputLatency || audioCtx.baseLatency || 0.015, 0, 0.24);
      const audioStart = audioCtx.currentTime + 2.3;
      audioStartTime = audioStart + latency;
      musicSource = audioCtx.createBufferSource();
      musicSource.buffer = songBuffer;
      musicSource.connect(musicGain);
      musicSource.start(audioStart);
    } else {
      useAudio = false;
      fallbackStart = nowSeconds() + 2.3;
    }
  }

  function stopMusic(fade = true) {
    if (!audioCtx || !musicSource) return;
    const source = musicSource;
    musicSource = null;
    try {
      if (fade && musicGain) {
        const now = audioCtx.currentTime;
        musicGain.gain.cancelScheduledValues(now);
        musicGain.gain.setTargetAtTime(0, now, 0.035);
        source.stop(now + 0.28);
      } else {
        source.stop();
      }
    } catch (_) { /* already stopped */ }
    if (musicGain) {
      const now = audioCtx.currentTime + (fade ? 0.35 : 0);
      musicGain.gain.setValueAtTime(fade ? 0 : 0.86, now);
    }
  }

  function getSongTime() {
    if (useAudio && audioCtx && audioStartTime) return audioCtx.currentTime - audioStartTime;
    return nowSeconds() - fallbackStart;
  }

  // ---------------------------------------------------------------------------
  // Scenery and sprites
  // ---------------------------------------------------------------------------

  function makeStars() {
    stars = [];
    for (let i = 0; i < 92; i++) {
      stars.push({
        x: rng() * W,
        y: rng() * horizonY * 0.9,
        r: 0.35 + rng() * 1.25,
        a: 0.18 + rng() * 0.7,
        phase: rng() * TAU,
        speed: 0.45 + rng() * 1.7,
        color: rng() < 0.16 ? '255,150,236' : rng() < 0.22 ? '255,224,163' : '178,235,255',
      });
    }
  }

  function makeEmbers() {
    embers = [];
    for (let i = 0; i < 34; i++) {
      embers.push({
        x: rng(),
        y: rng(),
        size: 0.6 + rng() * 2.1,
        speed: 0.014 + rng() * 0.05,
        sway: 5 + rng() * 18,
        phase: rng() * TAU,
        alpha: 0.18 + rng() * 0.52,
        color: rng() < 0.34 ? '255,92,214' : rng() < 0.2 ? '255,205,112' : '71,247,255',
      });
    }
  }

  function buildBackground() {
    const b = bgCtx;
    b.setTransform(DPR, 0, 0, DPR, 0, 0);
    b.clearRect(0, 0, W, H);

    const sky = b.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#03000a');
    sky.addColorStop(0.24, '#0a0319');
    sky.addColorStop(0.46, '#210a37');
    sky.addColorStop(0.56, '#4b174f');
    sky.addColorStop(0.6, '#14061f');
    sky.addColorStop(1, '#04010b');
    b.fillStyle = sky;
    b.fillRect(0, 0, W, H);

    const haze = b.createRadialGradient(cx, horizonY - H * 0.03, 0, cx, horizonY, W * 0.78);
    haze.addColorStop(0, 'rgba(255,95,202,0.19)');
    haze.addColorStop(0.32, 'rgba(130,44,198,0.12)');
    haze.addColorStop(0.68, 'rgba(26,8,49,0.02)');
    haze.addColorStop(1, 'rgba(0,0,0,0)');
    b.fillStyle = haze;
    b.fillRect(0, 0, W, H);

    for (const star of stars) {
      b.fillStyle = `rgba(${star.color},${star.a * 0.6})`;
      b.beginPath();
      b.arc(star.x, star.y, star.r, 0, TAU);
      b.fill();
    }

    const sunR = Math.min(W * 0.205, H * 0.145, 150);
    const sunY = horizonY - sunR * 0.18;
    b.save();
    b.globalCompositeOperation = 'lighter';
    const sunGlow = b.createRadialGradient(cx, sunY, sunR * 0.2, cx, sunY, sunR * 2.8);
    sunGlow.addColorStop(0, 'rgba(255,203,118,0.24)');
    sunGlow.addColorStop(0.38, 'rgba(255,82,158,0.14)');
    sunGlow.addColorStop(1, 'rgba(255,60,170,0)');
    b.fillStyle = sunGlow;
    b.fillRect(cx - sunR * 3, sunY - sunR * 3, sunR * 6, sunR * 6);
    b.restore();

    const sun = b.createLinearGradient(0, sunY - sunR, 0, sunY + sunR);
    sun.addColorStop(0, '#fff0a8');
    sun.addColorStop(0.45, '#ffba68');
    sun.addColorStop(0.78, '#ff5d9f');
    sun.addColorStop(1, '#b82078');
    b.save();
    b.beginPath();
    b.arc(cx, sunY, sunR, 0, TAU);
    b.clip();
    b.fillStyle = sun;
    b.fillRect(cx - sunR, sunY - sunR, sunR * 2, sunR * 2);
    b.fillStyle = 'rgba(17,3,27,0.78)';
    for (let y = sunY - sunR * 0.08; y < sunY + sunR; y += Math.max(5, sunR * 0.095)) {
      b.fillRect(cx - sunR, y, sunR * 2, Math.max(1.5, sunR * 0.024));
    }
    b.restore();

    b.save();
    b.strokeStyle = 'rgba(255,151,219,0.18)';
    b.lineWidth = 1;
    b.beginPath();
    b.arc(cx, sunY, sunR + 7, 0, TAU);
    b.stroke();
    b.restore();

    // City silhouettes, drawn after the sun so the horizon feels grounded.
    const cityBase = horizonY + 6;
    let x = -24;
    while (x < W + 30) {
      const width = 7 + rng() * 32;
      const height = 10 + rng() * Math.min(108, H * 0.15);
      const top = cityBase - height;
      b.fillStyle = '#070311';
      b.fillRect(x, top, width, height + 10);
      if (rng() < 0.5) {
        b.fillStyle = 'rgba(75,240,255,0.12)';
        b.fillRect(x + 1, top, width - 2, 1);
      }
      if (rng() < 0.42) {
        b.fillStyle = rng() < 0.5 ? 'rgba(255,83,197,0.22)' : 'rgba(84,231,255,0.2)';
        const wx = x + 2 + rng() * Math.max(1, width - 6);
        const wy = top + 5 + rng() * Math.max(1, height - 10);
        b.fillRect(wx, wy, 1.4, 2.4);
      }
      if (height > 70 && rng() < 0.32) {
        b.strokeStyle = 'rgba(255,100,214,0.2)';
        b.beginPath();
        b.moveTo(x + width * 0.5, top);
        b.lineTo(x + width * 0.5, top - 7 - rng() * 12);
        b.stroke();
      }
      x += width + 1.5 + rng() * 5;
    }

    const horizon = b.createLinearGradient(0, horizonY - 2, 0, horizonY + 16);
    horizon.addColorStop(0, 'rgba(255,113,208,0)');
    horizon.addColorStop(0.4, 'rgba(255,113,208,0.32)');
    horizon.addColorStop(0.55, 'rgba(112,240,255,0.3)');
    horizon.addColorStop(1, 'rgba(18,4,32,0)');
    b.fillStyle = horizon;
    b.fillRect(0, horizonY - 3, W, 20);

    const floor = b.createLinearGradient(0, horizonY, 0, H);
    floor.addColorStop(0, 'rgba(23,6,42,0.38)');
    floor.addColorStop(0.42, 'rgba(8,2,20,0.1)');
    floor.addColorStop(1, 'rgba(2,0,7,0.68)');
    b.fillStyle = floor;
    b.fillRect(0, horizonY, W, H - horizonY);

    // Static perspective rails live in the background layer. Only the moving
    // horizontal beat lines are redrawn on the gameplay canvas.
    b.save();
    b.beginPath();
    b.rect(0, horizonY, W, H - horizonY);
    b.clip();
    for (let i = -9; i <= 9; i++) {
      const bottomX = cx + i * (W / 8.2);
      const topX = cx + i * (W * 0.018);
      b.strokeStyle = `rgba(143,78,255,${0.035 + Math.abs(i) * 0.006})`;
      b.lineWidth = 0.7;
      b.beginPath();
      b.moveTo(topX, horizonY);
      b.lineTo(bottomX, H);
      b.stroke();
    }
    b.strokeStyle = 'rgba(71,247,255,0.16)';
    b.lineWidth = 1;
    b.beginPath();
    b.moveTo(cx - W * 0.012, horizonY);
    b.lineTo(cx - W * 0.245, H);
    b.moveTo(cx + W * 0.012, horizonY);
    b.lineTo(cx + W * 0.245, H);
    b.stroke();
    b.restore();
  }

  function buildCutGradient() {
    cutLineGrad = ctx.createLinearGradient(cx - strikeR * 2.8, 0, cx + strikeR * 2.8, 0);
    cutLineGrad.addColorStop(0, 'rgba(71,247,255,0)');
    cutLineGrad.addColorStop(0.22, 'rgba(71,247,255,0.2)');
    cutLineGrad.addColorStop(0.5, 'rgba(233,255,255,0.88)');
    cutLineGrad.addColorStop(0.78, 'rgba(255,79,216,0.2)');
    cutLineGrad.addColorStop(1, 'rgba(255,79,216,0)');

    horizonGlow = ctx.createRadialGradient(cx, horizonY, 0, cx, horizonY, W * 0.66);
    horizonGlow.addColorStop(0, 'rgba(255,107,206,0.2)');
    horizonGlow.addColorStop(0.36, 'rgba(118,44,211,0.11)');
    horizonGlow.addColorStop(1, 'rgba(0,0,0,0)');
  }

  function resize() {
    W = Math.max(320, window.innerWidth || 320);
    H = Math.max(480, window.innerHeight || 480);
    DPR = clamp(window.devicePixelRatio || 1, 1, dprCap);
    canvas.width = Math.max(1, Math.round(W * DPR));
    canvas.height = Math.max(1, Math.round(H * DPR));
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    bgLayer.width = canvas.width;
    bgLayer.height = canvas.height;
    bgLayer.style.width = `${W}px`;
    bgLayer.style.height = `${H}px`;
    bgCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    cx = W * 0.5;
    const portrait = H >= W;
    horizonY = H * (portrait ? 0.365 : 0.38);
    strikeY = H * (portrait ? 0.685 : 0.665);
    strikeR = portrait
      ? Math.min(W * 0.255, H * 0.135, 118)
      : Math.min(W * 0.17, H * 0.15, 112);
    makeStars();
    buildBackground();
    buildCutGradient();
    qualityTime = 0;
    qualityFrames = 0;
    qualityWarmup = 0.9;
  }

  function buildEnemySprite(type) {
    const style = TYPES[type];
    const canvasSize = 256;
    const sprite = document.createElement('canvas');
    sprite.width = canvasSize;
    sprite.height = canvasSize;
    const g = sprite.getContext('2d');
    g.translate(128, 132);
    g.lineJoin = 'round';
    g.lineCap = 'round';

    const aura = g.createRadialGradient(0, 0, 4, 0, 0, 122);
    aura.addColorStop(0, rgba(style.color, 0.34));
    aura.addColorStop(0.35, rgba(style.color, 0.13));
    aura.addColorStop(1, rgba(style.color, 0));
    g.fillStyle = aura;
    g.beginPath();
    g.arc(0, 0, 124, 0, TAU);
    g.fill();

    // Outer floating shards.
    g.strokeStyle = rgba(style.color, 0.56);
    g.lineWidth = 2.2;
    for (const shard of [
      [-102, -34, 8, 20, 0.34], [102, -26, 8, 16, -0.42], [-88, 56, 5, 12, 0.18],
      [91, 61, 6, 13, -0.22], [0, -112, 5, 15, 0.1],
    ]) {
      g.save();
      g.translate(shard[0], shard[1]);
      g.rotate(shard[4]);
      g.beginPath();
      g.moveTo(0, -shard[3]);
      g.lineTo(shard[2], 0);
      g.lineTo(0, shard[3]);
      g.lineTo(-shard[2], 0);
      g.closePath();
      g.stroke();
      g.restore();
    }

    // Shoulder blades.
    g.fillStyle = '#080311';
    g.strokeStyle = rgba(style.color, 0.66);
    g.lineWidth = 2.6;
    g.beginPath();
    g.moveTo(-48, -8);
    g.lineTo(-103, 17);
    g.lineTo(-87, 38);
    g.lineTo(-42, 28);
    g.closePath();
    g.fill();
    g.stroke();
    g.beginPath();
    g.moveTo(48, -8);
    g.lineTo(103, 17);
    g.lineTo(87, 38);
    g.lineTo(42, 28);
    g.closePath();
    g.fill();
    g.stroke();

    // Main horned mask.
    g.shadowColor = style.color;
    g.shadowBlur = 18;
    g.fillStyle = '#07020f';
    g.strokeStyle = rgba(style.color, 0.92);
    g.lineWidth = 3.4;
    g.beginPath();
    g.moveTo(0, -86);
    g.lineTo(28, -50);
    g.lineTo(63, -76);
    g.lineTo(56, -12);
    g.lineTo(38, 54);
    g.lineTo(0, 83);
    g.lineTo(-38, 54);
    g.lineTo(-56, -12);
    g.lineTo(-63, -76);
    g.lineTo(-28, -50);
    g.closePath();
    g.fill();
    g.stroke();
    g.shadowBlur = 0;

    const face = g.createLinearGradient(0, -45, 0, 65);
    face.addColorStop(0, rgba(style.color, 0.2));
    face.addColorStop(0.5, 'rgba(17,4,30,0.88)');
    face.addColorStop(1, 'rgba(5,1,12,0.96)');
    g.fillStyle = face;
    g.beginPath();
    g.moveTo(0, -52);
    g.lineTo(31, -22);
    g.lineTo(23, 31);
    g.lineTo(0, 56);
    g.lineTo(-23, 31);
    g.lineTo(-31, -22);
    g.closePath();
    g.fill();

    g.strokeStyle = rgba(style.color, 0.34);
    g.lineWidth = 1.3;
    g.beginPath();
    g.moveTo(-31, -22);
    g.lineTo(0, 0);
    g.lineTo(31, -22);
    g.moveTo(0, 0);
    g.lineTo(0, 56);
    g.stroke();

    // Eyes.
    g.shadowColor = style.color;
    g.shadowBlur = 24;
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(-31, -11);
    g.lineTo(-9, -5);
    g.lineTo(-12, 8);
    g.lineTo(-35, 3);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(31, -11);
    g.lineTo(9, -5);
    g.lineTo(12, 8);
    g.lineTo(35, 3);
    g.closePath();
    g.fill();

    // Mouth grille.
    g.shadowBlur = 0;
    g.strokeStyle = rgba(style.color, 0.54);
    g.lineWidth = 2;
    for (let i = -2; i <= 2; i++) {
      g.beginPath();
      g.moveTo(i * 8, 24);
      g.lineTo(i * 6, 43);
      g.stroke();
    }

    // Core diamond.
    g.fillStyle = rgba(style.color, 0.7);
    g.shadowColor = style.color;
    g.shadowBlur = 14;
    g.beginPath();
    g.moveTo(0, -32);
    g.lineTo(5, -22);
    g.lineTo(0, -12);
    g.lineTo(-5, -22);
    g.closePath();
    g.fill();
    g.shadowBlur = 0;

    // Fine scanlines across the body.
    g.strokeStyle = 'rgba(255,255,255,0.045)';
    g.lineWidth = 1;
    for (let y = -60; y < 60; y += 6) {
      g.beginPath();
      g.moveTo(-52, y);
      g.lineTo(52, y);
      g.stroke();
    }

    if (type === 'gold') {
      g.strokeStyle = 'rgba(255,226,154,0.44)';
      g.lineWidth = 1.4;
      g.beginPath();
      g.arc(0, 0, 90, 0, TAU);
      g.stroke();
    }

    return sprite;
  }

  function buildReticleSprite(color) {
    const reticle = document.createElement('canvas');
    reticle.width = 512;
    reticle.height = 512;
    const g = reticle.getContext('2d');
    g.translate(256, 256);
    g.lineJoin = 'round';
    g.lineCap = 'round';

    g.strokeStyle = rgba(color, 0.92);
    g.shadowColor = color;
    g.shadowBlur = 18;
    g.lineWidth = 4;
    g.beginPath();
    g.arc(0, 0, 200, 0, TAU);
    g.stroke();

    g.shadowBlur = 0;
    g.strokeStyle = rgba(color, 0.42);
    g.lineWidth = 1.8;
    g.beginPath();
    g.arc(0, 0, 136, 0, TAU);
    g.stroke();

    g.strokeStyle = rgba(color, 0.66);
    g.lineWidth = 2.4;
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * TAU;
      const inner = i % 3 === 0 ? 184 : 191;
      g.beginPath();
      g.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
      g.lineTo(Math.cos(angle) * 211, Math.sin(angle) * 211);
      g.stroke();
    }

    g.strokeStyle = rgba(color, 0.72);
    g.lineWidth = 2.6;
    const bracket = 180;
    const tick = 30;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const x = sx * bracket;
        const y = sy * bracket;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x - sx * tick, y);
        g.moveTo(x, y);
        g.lineTo(x, y - sy * tick);
        g.stroke();
      }
    }

    return reticle;
  }

  function buildRingSprite() {
    const ring = document.createElement('canvas');
    ring.width = 512;
    ring.height = 512;
    const g = ring.getContext('2d');
    g.translate(256, 256);
    g.strokeStyle = 'rgba(255,255,255,0.96)';
    g.shadowColor = '#ffffff';
    g.shadowBlur = 22;
    g.lineWidth = 5;
    g.beginPath();
    g.arc(0, 0, 200, 0, TAU);
    g.stroke();
    g.shadowBlur = 0;
    g.strokeStyle = 'rgba(255,255,255,0.72)';
    g.lineWidth = 1.6;
    g.beginPath();
    g.arc(0, 0, 193, 0, TAU);
    g.stroke();
    return ring;
  }

  function buildSprites() {
    sprites = {
      grunt: buildEnemySprite('grunt'),
      elite: buildEnemySprite('elite'),
      gold: buildEnemySprite('gold'),
      reticles: {
        grunt: buildReticleSprite(TYPES.grunt.color),
        elite: buildReticleSprite(TYPES.elite.color),
        gold: buildReticleSprite(TYPES.gold.color),
      },
      ring: buildRingSprite(),
    };
  }

  // ---------------------------------------------------------------------------
  // Run flow
  // ---------------------------------------------------------------------------

  let lastHud = { score: -1, combo: -1, health: -1, accuracy: -1, second: -1 };
  let lastDanger = false;

  function readBest() {
    try { return Number(localStorage.getItem(STORAGE_BEST)) || 0; } catch (_) { return 0; }
  }

  function writeBest(value) {
    try { localStorage.setItem(STORAGE_BEST, String(value)); } catch (_) { /* ignore */ }
  }

  function formatTime(seconds) {
    const safe = Math.max(0, Math.ceil(seconds));
    return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
  }

  function updateBestLabel() {
    ui.bestScore.textContent = padScore(readBest());
  }

  function resetRun() {
    score = 0;
    combo = 0;
    maxCombo = 0;
    health = MAX_HEALTH;
    judged = 0;
    perfectCount = 0;
    greatCount = 0;
    goodCount = 0;
    missCount = 0;
    accuracyPoints = 0;
    nextHealCombo = 20;
    nearestTarget = null;
    reticleFlash = 0;
    shake = 0;
    flash = 0;
    dying = false;
    failAt = 0;
    countdownValue = '';
    lastHud = { score: -1, combo: -1, health: -1, accuracy: -1, second: -1 };
    lastDanger = false;

    enemies = CHART.map((note) => ({
      hitTime: note.hitTime,
      type: note.type,
      curve: note.curve,
      seed: note.seed,
      state: 'idle',
      progress: 0,
      deadAt: 0,
      missedAt: 0,
      grade: '',
    }));

    for (const pool of [particles, waves, texts, slashes]) {
      for (const item of pool) item.life = 0;
    }

    ui.score.textContent = '000000';
    ui.combo.textContent = '0';
    ui.comboWrap.classList.remove('visible', 'pop');
    ui.accuracy.textContent = '100.0%';
    ui.progress.style.transform = 'scaleX(0)';
    ui.timeLeft.textContent = formatTime(SONG_DURATION);
    ui.countdownText.textContent = '3';
    ui.countdownText.classList.remove('fight');
    ui.countdown.classList.add('hidden');
    ui.screenEdge.classList.remove('danger');
    ui.toast.classList.add('hidden');
    updateShields();
  }

  function updateShields() {
    for (let i = 0; i < ui.shields.length; i++) {
      ui.shields[i].classList.toggle('lost', i >= health);
    }
  }

  async function startRun() {
    if (state === 'loading') return;
    state = 'loading';
    const token = ++runId;
    stopMusic(false);
    ui.resultScreen.classList.add('hidden');
    ui.pauseScreen.classList.add('hidden');
    ui.countdown.classList.add('hidden');
    ui.playBtn.classList.add('loading');
    ui.playLabel.textContent = 'SYNCING';

    const audioReady = await ensureAudio();
    useAudio = audioReady;
    if (audioReady) {
      try {
        await prepareSong();
      } catch (error) {
        console.warn('Could not render the track; continuing silently.', error);
        useAudio = false;
      }
    }
    if (token !== runId) return;

    resetRun();
    state = 'playing';
    ui.title.classList.add('hidden');
    ui.hud.classList.remove('hidden');
    ui.countdown.classList.remove('hidden');
    ui.playBtn.classList.remove('loading');
    ui.playLabel.textContent = 'START';
    beginTimeline();
  }

  function quitToTitle() {
    runId++;
    stopMusic(true);
    state = 'title';
    useAudio = false;
    audioStartTime = 0;
    dying = false;
    ui.hud.classList.add('hidden');
    ui.pauseScreen.classList.add('hidden');
    ui.resultScreen.classList.add('hidden');
    ui.countdown.classList.add('hidden');
    ui.title.classList.remove('hidden');
    ui.toast.classList.add('hidden');
    ui.screenEdge.classList.remove('danger');
    updateBestLabel();
  }

  function pauseRun() {
    if (state !== 'playing') return;
    state = 'paused';
    if (useAudio && audioCtx) {
      audioCtx.suspend().catch(() => {});
    } else {
      fallbackPausedAt = nowSeconds();
    }
    ui.pauseScreen.classList.remove('hidden');
    playSfx('ui');
  }

  function resumeRun() {
    if (state !== 'paused') return;
    if (useAudio && audioCtx) {
      audioCtx.resume().catch(() => {});
    } else {
      fallbackStart += nowSeconds() - fallbackPausedAt;
    }
    state = 'playing';
    ui.pauseScreen.classList.add('hidden');
    playSfx('ui');
  }

  function showToast(message, duration = 1100) {
    ui.toast.textContent = message;
    ui.toast.classList.remove('hidden');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => ui.toast.classList.add('hidden'), duration);
  }

  // ---------------------------------------------------------------------------
  // Judgement
  // ---------------------------------------------------------------------------

  function gradeFor(delta) {
    if (delta <= HIT_WINDOW.perfect) return 'PERFECT';
    if (delta <= HIT_WINDOW.great) return 'GREAT';
    return 'GOOD';
  }

  function findHitTarget(time) {
    let target = null;
    let closest = Infinity;
    for (const enemy of enemies) {
      if (enemy.state !== 'alive') continue;
      const distance = Math.abs(time - enemy.hitTime);
      if (distance <= HIT_WINDOW.good && distance < closest) {
        closest = distance;
        target = enemy;
      }
    }
    return target;
  }

  function findEarlyTarget(time) {
    let target = null;
    let closest = Infinity;
    for (const enemy of enemies) {
      if (enemy.state !== 'alive') continue;
      const distance = enemy.hitTime - time;
      if (distance > 0 && distance <= HIT_WINDOW.early && distance < closest) {
        closest = distance;
        target = enemy;
      }
    }
    return target;
  }

  function handleTap() {
    if (state !== 'playing' || dying) return;
    const time = getSongTime();
    if (time < 0) return;
    reticleFlash = 1;

    const target = findHitTarget(time);
    if (target) {
      hitEnemy(target, gradeFor(Math.abs(time - target.hitTime)));
      return;
    }

    const early = findEarlyTarget(time);
    if (early) {
      if (combo > 0) {
        combo = 0;
        updateHud(true);
      }
      spawnText(cx, strikeY - strikeR * 0.86, 'TOO EARLY', '#ff7096', 17, 0.48);
      playSfx('early');
    }
  }

  function hitEnemy(enemy, grade) {
    enemy.state = 'dead';
    enemy.deadAt = getSongTime();
    enemy.grade = grade;

    const type = TYPES[enemy.type];
    const base = grade === 'PERFECT' ? 1000 : grade === 'GREAT' ? 650 : 300;
    const multiplier = 1 + Math.min(3, Math.floor(combo / 10) * 0.5);
    const gained = Math.round(base * multiplier * type.score);
    score += gained;
    combo++;
    maxCombo = Math.max(maxCombo, combo);
    judged++;

    if (grade === 'PERFECT') {
      perfectCount++;
      accuracyPoints += 1;
    } else if (grade === 'GREAT') {
      greatCount++;
      accuracyPoints += 0.75;
    } else {
      goodCount++;
      accuracyPoints += 0.45;
    }

    const hitX = cx;
    const hitY = strikeY;
    const count = grade === 'PERFECT' ? 24 : grade === 'GREAT' ? 17 : 12;
    burst(hitX, hitY, type, count, grade === 'PERFECT' ? 430 : 330);
    spawnWave(hitX, hitY, type, grade === 'PERFECT' ? 1.2 : 0.8);
    spawnSlash(hitX, hitY, type, grade === 'PERFECT' ? 1.3 : 0.9);
    spawnText(hitX, hitY - strikeR * 0.82, grade, type.color, grade === 'PERFECT' ? 27 : 22, 0.72);
    spawnText(hitX, hitY + strikeR * 0.42, `+${gained}`, 'rgba(244,251,255,0.9)', 14, 0.6);

    reticleFlash = 1;
    shake = Math.max(shake, grade === 'PERFECT' ? 7 : 4.5);
    flash = Math.max(flash, grade === 'PERFECT' ? 0.8 : 0.42);
    flashColor = type.rgb;

    if (enemy.type === 'gold') {
      if (health < MAX_HEALTH) {
        health++;
        updateShields();
        spawnText(hitX, hitY - strikeR * 1.12, 'SHIELD +1', '#ffd166', 14, 0.8);
      }
      playSfx('gold', 1.02);
    }

    if (combo >= nextHealCombo) {
      nextHealCombo += 20;
      if (health < MAX_HEALTH) {
        health++;
        updateShields();
        showToast('20 COMBO · SHIELD +1', 1000);
      }
    }

    updateHud(true);
    popCombo();
    playSfx(grade === 'PERFECT' ? 'perfect' : grade === 'GREAT' ? 'great' : 'good');
    if (navigator.vibrate) navigator.vibrate(grade === 'PERFECT' ? 12 : 7);
  }

  function missEnemy(enemy) {
    enemy.state = 'missed';
    enemy.missedAt = getSongTime();
    missCount++;
    judged++;
    combo = 0;
    health = Math.max(0, health - 1);
    updateShields();
    updateHud(true);

    spawnText(cx, strikeY - strikeR * 0.72, 'MISS', '#ff4d6d', 24, 0.72);
    burst(cx, strikeY, { color: '#ff4d6d', rgb: '255,77,109' }, 10, 260);
    shake = Math.max(shake, 9);
    flash = Math.max(flash, 0.65);
    flashColor = '255,50,90';
    playSfx('miss');
    if (navigator.vibrate) navigator.vibrate([0, 28]);

    if (health <= 0 && !dying) {
      dying = true;
      failAt = getSongTime() + 0.9;
      showToast('SIGNAL LOST', 900);
    }
  }

  function popCombo() {
    ui.comboWrap.classList.remove('pop');
    void ui.comboWrap.offsetWidth;
    ui.comboWrap.classList.add('pop');
  }

  // ---------------------------------------------------------------------------
  // Frame update
  // ---------------------------------------------------------------------------

  function updateCountdown(time) {
    if (time < 0) {
      const number = Math.min(3, Math.max(1, Math.ceil(-time / 0.7)));
      const next = String(number);
      if (next !== countdownValue) {
        countdownValue = next;
        ui.countdownText.textContent = next;
        ui.countdownText.classList.remove('fight');
        ui.countdownText.style.animation = 'none';
        void ui.countdownText.offsetWidth;
        ui.countdownText.style.animation = '';
      }
      ui.countdown.classList.remove('hidden');
    } else if (time < 0.55) {
      if (countdownValue !== 'CUT!') {
        countdownValue = 'CUT!';
        ui.countdownText.textContent = 'CUT!';
        ui.countdownText.classList.add('fight');
        ui.countdownText.style.animation = 'none';
        void ui.countdownText.offsetWidth;
        ui.countdownText.style.animation = '';
      }
      ui.countdown.classList.remove('hidden');
    } else if (countdownValue) {
      countdownValue = '';
      ui.countdown.classList.add('hidden');
    }
  }

  function updateGame(dt) {
    const time = getSongTime();
    updateCountdown(time);

    if (time >= 0) {
      for (const enemy of enemies) {
        if (enemy.state === 'idle' && time >= enemy.hitTime - TRAVEL_TIME) {
          enemy.state = 'alive';
          enemy.progress = 0;
        }
        if (enemy.state === 'alive') {
          enemy.progress = clamp((time - (enemy.hitTime - TRAVEL_TIME)) / TRAVEL_TIME, 0, 1);
          if (time > enemy.hitTime + HIT_WINDOW.good) missEnemy(enemy);
        } else if (enemy.state === 'missed') {
          enemy.progress = 1 + clamp((time - enemy.hitTime) / 0.55, 0, 1);
        }
      }
    }

    if (dying && time >= failAt) {
      finishRun(true);
      return;
    }
    if (time >= SONG_DURATION - 0.18) {
      finishRun(false);
      return;
    }

    updateHud(false);
    updateEffects(dt);
  }

  function updateHud(force = false) {
    if (score !== lastHud.score || force) {
      ui.score.textContent = padScore(score);
      lastHud.score = score;
    }
    if (combo !== lastHud.combo || force) {
      ui.combo.textContent = String(combo);
      ui.comboWrap.classList.toggle('visible', combo >= 2);
      lastHud.combo = combo;
    }
    if (health !== lastHud.health || force) {
      updateShields();
      lastHud.health = health;
    }

    const accuracy = judged > 0 ? (accuracyPoints / judged) * 100 : 100;
    const roundedAccuracy = Math.round(accuracy * 10) / 10;
    if (roundedAccuracy !== lastHud.accuracy || force) {
      ui.accuracy.textContent = `${roundedAccuracy.toFixed(1)}%`;
      lastHud.accuracy = roundedAccuracy;
    }

    const time = Math.max(0, getSongTime());
    const progress = clamp(time / SONG_DURATION, 0, 1);
    ui.progress.style.transform = `scaleX(${progress.toFixed(4)})`;
    const second = Math.max(0, Math.ceil(SONG_DURATION - time));
    if (second !== lastHud.second || force) {
      ui.timeLeft.textContent = formatTime(second);
      lastHud.second = second;
    }

    const danger = state === 'playing' && health <= 2;
    if (danger !== lastDanger) {
      lastDanger = danger;
      ui.screenEdge.classList.toggle('danger', danger);
    }
  }

  function finishRun(failed) {
    if (state !== 'playing') return;
    state = 'results';
    stopMusic(true);
    ui.countdown.classList.add('hidden');
    ui.screenEdge.classList.remove('danger');
    lastDanger = false;

    const total = CHART.length;
    const finalAccuracy = total > 0 ? (accuracyPoints / total) * 100 : 0;
    let rank = 'D';
    if (failed) {
      rank = 'F';
    } else if (finalAccuracy >= 99.4 && missCount === 0) {
      rank = 'S+';
    } else if (finalAccuracy >= 96) {
      rank = 'S';
    } else if (finalAccuracy >= 90) {
      rank = 'A';
    } else if (finalAccuracy >= 82) {
      rank = 'B';
    } else if (finalAccuracy >= 70) {
      rank = 'C';
    }

    ui.resultKicker.innerHTML = failed
      ? '<i></i> SIGNAL LOST <i></i>'
      : '<i></i> STAGE CLEAR <i></i>';
    ui.resultRank.textContent = rank;
    ui.resultRank.classList.remove('rank-splus', 'rank-f');
    if (rank === 'S+') ui.resultRank.classList.add('rank-splus');
    if (rank === 'F') ui.resultRank.classList.add('rank-f');
    ui.resultTitle.textContent = failed ? 'SIGNAL LOST' : 'CUT COMPLETE';
    ui.finalScore.textContent = padScore(score);
    ui.statPerfect.textContent = String(perfectCount);
    ui.statGreat.textContent = String(greatCount);
    ui.statGood.textContent = String(goodCount);
    ui.statMiss.textContent = String(missCount);
    ui.statCombo.textContent = String(maxCombo);
    ui.statAccuracy.textContent = `${finalAccuracy.toFixed(1)}%`;

    const previousBest = readBest();
    const isNewBest = score > previousBest;
    if (isNewBest) writeBest(score);
    updateBestLabel();
    ui.newBest.classList.toggle('hidden', !isNewBest || score <= 0);
    ui.resultScreen.classList.remove('hidden');
    playSfx(isNewBest ? 'gold' : 'ui', isNewBest ? 0.9 : 1);
    if (navigator.vibrate) navigator.vibrate(failed ? [0, 60, 40, 80] : [0, 18, 40, 30]);
  }

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  let particleCursor = 0;
  let waveCursor = 0;
  let textCursor = 0;
  let slashCursor = 0;

  function takeFromPool(pool, cursorName) {
    const offset = cursorName === 'particle' ? particleCursor
      : cursorName === 'wave' ? waveCursor
        : cursorName === 'text' ? textCursor : slashCursor;
    for (let i = 0; i < pool.length; i++) {
      const item = pool[(offset + i) % pool.length];
      if (item.life <= 0) {
        const next = (offset + i + 1) % pool.length;
        if (cursorName === 'particle') particleCursor = next;
        else if (cursorName === 'wave') waveCursor = next;
        else if (cursorName === 'text') textCursor = next;
        else slashCursor = next;
        return item;
      }
    }
    return pool[offset % pool.length];
  }

  function burst(x, y, type, count, power) {
    for (let i = 0; i < count; i++) {
      const particle = takeFromPool(particles, 'particle');
      const angle = Math.random() * TAU;
      const speed = power * (0.35 + Math.random() * 0.95);
      particle.life = 0.3 + Math.random() * 0.52;
      particle.maxLife = particle.life;
      particle.x = x + (Math.random() - 0.5) * 18;
      particle.y = y + (Math.random() - 0.5) * 18;
      particle.vx = Math.cos(angle) * speed;
      particle.vy = Math.sin(angle) * speed - 80;
      particle.size = 1.2 + Math.random() * 3.5;
      particle.color = type.color;
      particle.rgb = type.rgb;
      particle.shard = Math.random() < 0.42;
      particle.angle = Math.random() * TAU;
      particle.spin = (Math.random() * 2 - 1) * 12;
    }
  }

  function spawnWave(x, y, type, strength) {
    const wave = takeFromPool(waves, 'wave');
    wave.life = 0.42 + strength * 0.18;
    wave.maxLife = wave.life;
    wave.x = x;
    wave.y = y;
    wave.r = strikeR * 0.4;
    wave.speed = 440 * strength;
    wave.color = type.color;
    wave.rgb = type.rgb;
  }

  function spawnSlash(x, y, type, strength) {
    for (let i = 0; i < 2; i++) {
      const slash = takeFromPool(slashes, 'slash');
      slash.life = 0.18 + strength * 0.1;
      slash.maxLife = slash.life;
      slash.x = x;
      slash.y = y;
      slash.r = strikeR * (0.8 + i * 0.24);
      slash.angle = -0.72 + i * 1.42 + (Math.random() - 0.5) * 0.24;
      slash.color = type.color;
      slash.rgb = type.rgb;
    }
  }

  function spawnText(x, y, text, color, size, life) {
    const item = takeFromPool(texts, 'text');
    item.life = life;
    item.maxLife = life;
    item.x = x;
    item.y = y;
    item.text = text;
    item.color = color;
    item.size = size;
    item.vy = 38 + size * 0.9;
  }

  function updateEffects(dt) {
    for (const particle of particles) {
      if (particle.life <= 0) continue;
      particle.life -= dt;
      if (particle.life <= 0) continue;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vy += (particle.shard ? 720 : 180) * dt;
      particle.vx *= 0.986;
      particle.angle += particle.spin * dt;
    }
    for (const wave of waves) {
      if (wave.life <= 0) continue;
      wave.life -= dt;
      wave.r += wave.speed * dt;
    }
    for (const text of texts) {
      if (text.life <= 0) continue;
      text.life -= dt;
      text.y -= text.vy * dt;
      text.vy *= 0.95;
    }
    for (const slash of slashes) {
      if (slash.life > 0) slash.life -= dt;
    }
    reticleFlash = Math.max(0, reticleFlash - dt * 5.4);
    shake *= Math.exp(-dt * 11.5);
    if (shake < 0.06) shake = 0;
    flash *= Math.exp(-dt * 9.5);
    if (flash < 0.008) flash = 0;
  }

  function drawEffects() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const slash of slashes) {
      if (slash.life <= 0) continue;
      const alpha = clamp(slash.life / slash.maxLife, 0, 1);
      ctx.strokeStyle = rgba(slash.color, alpha * 0.95);
      ctx.lineWidth = 9 * alpha + 1;
      ctx.beginPath();
      ctx.arc(slash.x, slash.y, slash.r, slash.angle - 0.64, slash.angle + 0.64);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.92})`;
      ctx.lineWidth = 2.4 * alpha + 0.6;
      ctx.beginPath();
      ctx.arc(slash.x, slash.y, slash.r, slash.angle - 0.62, slash.angle + 0.62);
      ctx.stroke();
    }

    for (const wave of waves) {
      if (wave.life <= 0) continue;
      const alpha = clamp(wave.life / wave.maxLife, 0, 1);
      ctx.strokeStyle = rgba(wave.color, alpha * 0.65);
      ctx.lineWidth = 2 + alpha * 3;
      ctx.beginPath();
      ctx.ellipse(wave.x, wave.y, wave.r, wave.r * 0.3, 0, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.3})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(wave.x, wave.y, wave.r * 0.72, wave.r * 0.22, 0, 0, TAU);
      ctx.stroke();
    }

    for (const particle of particles) {
      if (particle.life <= 0) continue;
      const alpha = clamp(particle.life / particle.maxLife, 0, 1);
      ctx.strokeStyle = rgba(particle.color, alpha * 0.88);
      ctx.lineWidth = particle.size;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(particle.x, particle.y);
      ctx.lineTo(particle.x - particle.vx * 0.016, particle.y - particle.vy * 0.016);
      ctx.stroke();
      if (particle.shard) {
        ctx.save();
        ctx.translate(particle.x, particle.y);
        ctx.rotate(particle.angle);
        ctx.fillStyle = rgba(particle.color, alpha * 0.7);
        ctx.fillRect(-particle.size * 0.8, -particle.size * 0.18, particle.size * 1.6, particle.size * 0.36);
        ctx.restore();
      }
    }

    ctx.globalCompositeOperation = 'source-over';
    for (const text of texts) {
      if (text.life <= 0) continue;
      const progress = 1 - text.life / text.maxLife;
      const alpha = clamp(text.life / text.maxLife, 0, 1);
      const scale = progress < 0.18 ? lerp(1.45, 1, progress / 0.18) : 1;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(text.x, text.y);
      ctx.scale(scale, scale);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `italic 900 ${text.size}px "Arial Black", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
      ctx.shadowColor = text.color;
      ctx.shadowBlur = 14;
      ctx.fillStyle = text.color;
      ctx.fillText(text.text, 0, 0);
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function drawBackground(now) {
    if (bgCanvas) ctx.drawImage(bgCanvas, 0, 0, W, H);

    const time = Math.max(0, getSongTime());
    const beatPos = time / BEAT;
    const beatFraction = beatPos - Math.floor(beatPos);
    const pulse = Math.exp(-beatFraction * 7.5);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.28 + pulse * 0.34;
    ctx.fillStyle = horizonGlow;
    ctx.fillRect(0, horizonY - H * 0.2, W, H * 0.4);
    ctx.restore();

    if (!renderFlags.stars) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const star of stars) {
      const twinkle = 0.42 + 0.58 * (0.5 + 0.5 * Math.sin(now * star.speed + star.phase));
      ctx.fillStyle = `rgba(${star.color},${star.a * twinkle})`;
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawGrid(now) {
    const phase = ((now * 0.56) % 1 + 1) % 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, horizonY, W, H - horizonY);
    ctx.clip();

    for (let i = 0; i < 14; i++) {
      const p = (i + phase) / 14;
      const y = horizonY + Math.pow(p, 1.75) * (H - horizonY + 42);
      const alpha = 0.04 + p * 0.27;
      ctx.strokeStyle = i % 2 === 0
        ? `rgba(83,220,255,${alpha})`
        : `rgba(188,87,255,${alpha * 0.72})`;
      ctx.lineWidth = 0.6 + p * 1.8;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawGates(now) {
    const phase = ((now * 0.31) % 1 + 1) % 1;
    ctx.save();
    for (let i = 0; i < 5; i++) {
      const z = (i + phase) / 5;
      const p = z * z;
      const y = horizonY + p * (H - horizonY);
      const half = W * (0.09 + 0.61 * p);
      const height = H * (0.018 + 0.17 * p);
      const alpha = 0.045 + p * 0.27;
      const color = i % 2 === 0 ? '71,247,255' : '255,79,216';
      ctx.strokeStyle = `rgba(${color},${alpha})`;
      ctx.lineWidth = 0.8 + p * 2.6;
      ctx.beginPath();
      ctx.moveTo(cx - half, y);
      ctx.lineTo(cx - half, y - height);
      ctx.lineTo(cx - half + W * 0.028, y - height);
      ctx.moveTo(cx + half, y);
      ctx.lineTo(cx + half, y - height);
      ctx.lineTo(cx + half - W * 0.028, y - height);
      ctx.moveTo(cx - half + W * 0.04, y - height);
      ctx.lineTo(cx + half - W * 0.04, y - height);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawEmbers(now) {
    ctx.save();
    for (const ember of embers) {
      const y = ((ember.y - now * ember.speed) % 1 + 1) % 1;
      const x = ember.x * W + Math.sin(now * 0.5 + ember.phase) * ember.sway;
      const alpha = ember.alpha * (0.56 + 0.44 * Math.sin(now * 1.4 + ember.phase));
      ctx.fillStyle = `rgba(${ember.color},${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y * H, ember.size, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawCutLine(now) {
    const time = Math.max(0, getSongTime());
    const beatFraction = time / BEAT - Math.floor(time / BEAT);
    const pulse = Math.exp(-beatFraction * 8);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = cutLineGrad;
    ctx.lineWidth = 1.2 + pulse * 1.4;
    ctx.beginPath();
    ctx.moveTo(cx - strikeR * 2.8, strikeY);
    ctx.lineTo(cx + strikeR * 2.8, strikeY);
    ctx.stroke();
    ctx.globalAlpha = 0.16 + pulse * 0.12;
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.restore();
  }

  function nearestVisualTarget() {
    const time = getSongTime();
    let target = null;
    let closest = Infinity;
    for (const enemy of enemies) {
      if (enemy.state !== 'alive') continue;
      const distance = Math.abs(time - enemy.hitTime);
      if (distance < closest) {
        closest = distance;
        target = enemy;
      }
    }
    return target && closest <= 0.56 ? { enemy: target, delta: time - target.hitTime, approach: clamp(1 - closest / 0.56, 0, 1) } : null;
  }

  function drawRing(radius, alpha) {
    if (!sprites.ring || alpha <= 0.01) return;
    const scaleX = radius / 200;
    const scaleY = radius * 0.32 / 200;
    ctx.save();
    ctx.translate(cx, strikeY);
    ctx.scale(scaleX, scaleY);
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprites.ring, -256, -256, 512, 512);
    ctx.restore();
  }

  function drawReticle(now) {
    const time = Math.max(0, getSongTime());
    const beatPos = time / BEAT;
    const beatFraction = beatPos - Math.floor(beatPos);
    const beatPulse = Math.exp(-beatFraction * 7);
    const targetInfo = nearestVisualTarget();
    nearestTarget = targetInfo;
    const approach = targetInfo ? targetInfo.approach : 0;
    const R = strikeR * (1 + beatPulse * 0.04);
    const close = targetInfo && Math.abs(targetInfo.delta) <= HIT_WINDOW.good;
    const sprite = targetInfo
      ? sprites.reticles[targetInfo.enemy.type]
      : sprites.reticles.grunt;

    if (sprite) {
      ctx.save();
      ctx.translate(cx, strikeY);
      ctx.scale(R / 200, R * 0.32 / 200);
      ctx.globalAlpha = 0.38 + approach * 0.62;
      ctx.drawImage(sprite, -256, -256, 512, 512);
      ctx.restore();
    }

    const timingR = R * (1 + (1 - approach) * 1.45);
    const timingAlpha = close
      ? 0.62 + (1 - Math.abs(targetInfo.delta) / HIT_WINDOW.good) * 0.34
      : 0.12 + approach * 0.5;
    drawRing(timingR, timingAlpha);

    if (reticleFlash > 0) {
      const flashR = R * (1 + (1 - reticleFlash) * 0.38);
      drawRing(flashR, reticleFlash * 0.82);
    }
  }

  function drawEnemy(enemy, now, targetInfo) {
    const type = TYPES[enemy.type];
    const sprite = sprites[enemy.type];
    if (!sprite) return;

    const time = getSongTime();
    const p = enemy.progress;
    const visualP = clamp(p, 0, 1.6);
    const x = cx + enemy.curve * Math.pow(1 - clamp(p, 0, 1), 2) * W * 0.15;
    const y = horizonY + (strikeY - horizonY) * Math.pow(visualP, 1.55);
    const size = lerp(strikeR * 0.22, strikeR * 2.12, Math.pow(visualP, 1.28)) * type.scale;
    const bob = Math.sin(now * 3.1 + enemy.seed * 9) * size * 0.018 * clamp(p, 0, 1);
    const rotation = Math.sin(now * 1.7 + enemy.seed * 8) * 0.035 * clamp(p, 0, 1);
    const alpha = enemy.state === 'missed'
      ? clamp(1 - (p - 1) / 0.55, 0, 1)
      : clamp(p * 8, 0, 1);

    if (alpha <= 0) return;

    ctx.save();
    ctx.globalAlpha = alpha;

    ctx.fillStyle = `rgba(0,0,0,${0.2 + clamp(p, 0, 1) * 0.28})`;
    ctx.beginPath();
    ctx.ellipse(x, y + size * 0.28, size * 0.25, size * 0.055, 0, 0, TAU);
    ctx.fill();

    if (targetInfo && targetInfo.enemy === enemy) {
      ctx.save();
      ctx.translate(x, y + bob);
      ctx.strokeStyle = rgba(type.color, 0.34 + targetInfo.approach * 0.46);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([7, 10]);
      ctx.lineDashOffset = -now * 34;
      ctx.beginPath();
      ctx.ellipse(0, 0, size * 0.52, size * 0.52, 0, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    ctx.save();
    ctx.translate(x, y + bob);
    ctx.rotate(rotation);
    ctx.drawImage(sprite, -size * 0.5, -size * 0.5, size, size);

    if (enemy.state === 'missed') {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,45,84,${0.2 + (1 - alpha) * 0.45})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, size * 0.46, size * 0.46, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    ctx.restore();

    if (enemy.state === 'missed' && time - enemy.missedAt < 0.5) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(255,45,84,${(1 - (time - enemy.missedAt) / 0.5) * 0.34})`;
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 3; i++) {
        const offset = (i - 1) * size * 0.1;
        ctx.beginPath();
        ctx.moveTo(x - size * 0.44, y + offset);
        ctx.lineTo(x + size * 0.44, y + offset + (i % 2 ? 4 : -4));
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawEnemies(now) {
    const active = [];
    for (const enemy of enemies) {
      if (enemy.state === 'alive' || enemy.state === 'missed') active.push(enemy);
    }
    active.sort((a, b) => a.progress - b.progress);
    const targetInfo = nearestTarget;
    for (const enemy of active) drawEnemy(enemy, now, targetInfo);
  }

  function drawTitleEnemy(now) {
    const sprite = sprites.grunt;
    if (!sprite) return;
    const size = Math.min(W * 0.64, H * 0.43, 390);
    const x = cx;
    const y = H * 0.6 + Math.sin(now * 1.15) * 7;
    ctx.save();
    ctx.globalAlpha = 0.23;
    ctx.translate(x, y);
    ctx.rotate(Math.sin(now * 0.6) * 0.025);
    ctx.drawImage(sprite, -size * 0.5, -size * 0.5, size, size);
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(71,247,255,0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(x, y + size * 0.25, size * 0.34, size * 0.075, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  function render(now) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    if (shake > 0.1) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    }

    if (renderFlags.grid) drawGrid(now);
    if (renderFlags.gates) drawGates(now);
    if (renderFlags.embers) drawEmbers(now);
    if (renderFlags.reticle) drawCutLine(now);
    if (renderFlags.reticle) drawReticle(now);
    if (renderFlags.enemies) {
      if (state === 'title') {
        drawTitleEnemy(now);
      } else {
        drawEnemies(now);
      }
    }
    if (renderFlags.effects) drawEffects();

    if (flash > 0.01) {
      ctx.fillStyle = `rgba(${flashColor},${Math.min(0.24, flash * 0.24)})`;
      ctx.fillRect(-20, -20, W + 40, H + 40);
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Input, resize, boot
  // ---------------------------------------------------------------------------

  function bindEvents() {
    ui.playBtn.addEventListener('click', () => {
      startRun();
    });
    ui.replayBtn.addEventListener('click', () => {
      startRun();
    });
    ui.homeBtn.addEventListener('click', () => {
      quitToTitle();
    });
    ui.resumeBtn.addEventListener('click', () => {
      resumeRun();
    });
    ui.quitBtn.addEventListener('click', () => {
      quitToTitle();
    });
    ui.pauseBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      pauseRun();
    });
    ui.muteBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      setMuted(!muted);
      playSfx('ui');
    });

    canvas.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      if (state === 'playing') handleTap();
    }, { passive: false });

    window.addEventListener('keydown', (event) => {
      if (event.repeat) return;
      if (event.code === 'Space' || event.code === 'Enter' || event.code === 'ArrowDown') {
        if (state === 'title') {
          event.preventDefault();
          startRun();
        } else if (state === 'playing') {
          event.preventDefault();
          handleTap();
        } else if (state === 'results') {
          event.preventDefault();
          startRun();
        } else if (state === 'paused') {
          event.preventDefault();
          resumeRun();
        }
      }
      if (event.code === 'Escape' || event.key.toLowerCase() === 'p') {
        if (state === 'playing') {
          event.preventDefault();
          pauseRun();
        } else if (state === 'paused') {
          event.preventDefault();
          resumeRun();
        }
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state === 'playing') pauseRun();
    });
    window.addEventListener('blur', () => {
      if (state === 'playing') pauseRun();
    });

    document.addEventListener('contextmenu', (event) => event.preventDefault());
    document.addEventListener('gesturestart', (event) => event.preventDefault());
    document.addEventListener('touchmove', (event) => {
      if (state === 'playing') event.preventDefault();
    }, { passive: false });

    let resizeTimer = 0;
    const scheduleResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resize();
        updateHud(true);
      }, 120);
    };
    window.addEventListener('resize', scheduleResize);
    window.addEventListener('orientationchange', scheduleResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleResize);
  }

  function monitorPerformance(dt) {
    if (!autoDpr || document.hidden || state === 'paused' || state === 'results' || dt > 0.09) {
      qualityTime = 0;
      qualityFrames = 0;
      return;
    }
    if (qualityWarmup > 0) {
      qualityWarmup -= dt;
      return;
    }
    qualityTime += dt;
    qualityFrames++;
    if (qualityTime < 1.2 || qualityFrames < 24) return;

    const average = qualityTime / qualityFrames;
    qualityTime = 0;
    qualityFrames = 0;
    if (average > 0.024 && DPR > 1.01) {
      dprCap = Math.max(1, Math.round((DPR - 0.25) * 100) / 100);
      resize();
    }
  }

  function frame(timestamp) {
    const now = timestamp / 1000;
    const dt = clamp(now - lastNow, 0.001, 0.05);
    lastNow = now;

    if (state === 'playing') {
      updateGame(dt);
    } else if (state !== 'paused' && state !== 'results') {
      updateEffects(dt);
    }

    monitorPerformance(dt);
    if (state !== 'paused' && state !== 'results') render(now);
    window.requestAnimationFrame(frame);
  }

  function boot() {
    setMuted(muted);
    updateBestLabel();
    makeEmbers();
    buildSprites();
    resize();
    bindEvents();

    // A tiny debug surface makes automated visual checks deterministic.
    window.__NEON = {
      get snapshot() {
        return {
          state,
          songTime: Number(getSongTime().toFixed(3)),
          score,
          combo,
          maxCombo,
          health,
          judged,
          chart: CHART.length,
          audio: Boolean(audioCtx),
          musicReady: Boolean(songBuffer),
          prepareMs: lastPrepareMs,
          dpr: DPR,
          dprCap,
          autoDpr,
          audioState: audioCtx ? audioCtx.state : 'none',
          chartTimes: CHART.map((note) => note.hitTime),
          activeEnemies: enemies.filter((enemy) => enemy.state === 'alive').length,
          enemies: enemies
            .filter((enemy) => enemy.state === 'alive' || enemy.state === 'missed')
            .map((enemy) => ({
              hitTime: enemy.hitTime,
              state: enemy.state,
              progress: Number(enemy.progress.toFixed(2)),
            })),
          liveTexts: texts.filter((text) => text.life > 0).map((text) => text.text),
          accuracyLabel: ui.accuracy.textContent,
        };
      },
      start: startRun,
      tap: handleTap,
      finish: () => finishRun(false),
      fail: () => finishRun(true),
      pause: pauseRun,
      resume: resumeRun,
      home: quitToTitle,
      setFlags: (flags) => Object.assign(renderFlags, flags),
      setDprCap: (value) => {
        autoDpr = false;
        dprCap = clamp(value, 1, 2);
        resize();
      },
      setAutoDpr: (enabled) => {
        autoDpr = Boolean(enabled);
        dprCap = MAX_DPR;
        resize();
      },
    };

    window.requestAnimationFrame(frame);
  }

  boot();
})();
