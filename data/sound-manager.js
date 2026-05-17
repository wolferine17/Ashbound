// ════════════════════════════════════════════════════════════════════
// SOUND MANAGER — centralized audio for Ashbound
// Uses HTML5 Audio (no Web Audio API). All sound files live in sounds/.
// Loaded as a plain <script> before index.html's inline script so the
// SOUNDS constant and SoundManager object become globals.
// ════════════════════════════════════════════════════════════════════

const SOUNDS = {
  intro:        'sounds/Ashbound Intro.mp3',
  menus:        'sounds/Menus.mp3',
  cardPlay:     'sounds/Cards from deck coming to play.mp3',
  cardElim:     'sounds/Card_eliminated.mp3',
  hit:          'sounds/Hit.mp3',
  healing:      'sounds/Healing.mp3',
  victorySting: 'sounds/Victory man.mp3',
  victoryBgm:   'sounds/Win background.mp3',
  defeatSting:  'sounds/Defeat.mp3',
  defeatBgm:    'sounds/Defeat background noise.mp3',
};

const SoundManager = {
  muted: false,
  volume: 0.8,          // master volume 0..1
  currentBgm: null,     // { name, audio } — single looping menu/battle BGM
  layeredSting: null,   // { name, audio } — Victory/Defeat one-shot vocal
  layeredBgm: null,     // { name, audio } — Win/Defeat looping background
  _userInteracted: false, // set true after first user gesture (autoplay gate)

  init() {
    // Restore prefs from localStorage (set BEFORE any audio plays)
    try {
      const m = localStorage.getItem('ashbound_muted');
      if (m != null) this.muted = (m === '1' || m === 'true');
      const v = localStorage.getItem('ashbound_volume');
      if (v != null) {
        const parsed = parseFloat(v);
        if (!isNaN(parsed)) this.volume = Math.max(0, Math.min(1, parsed));
      }
    } catch (e) { /* localStorage unavailable */ }
  },

  markInteracted() { this._userInteracted = true; },

  // Per-sound volume multipliers (relative to master). 1.0 = use master as-is.
  // Use to tame sounds that are inherently louder than the rest.
  _gainOverrides: {
    intro: 0.80,   // ~20% quieter than master so the intro doesn't blow ears out
  },

  // Play a one-shot sound. Each call creates a fresh Audio so overlapping calls work.
  // Optional opts.volumeMult overrides the per-sound default.
  play(name, opts) {
    if (this.muted || !this._userInteracted) return null;
    const src = SOUNDS[name];
    if (!src) { console.warn('SoundManager.play unknown sound:', name); return null; }
    try {
      const a = new Audio(src);
      const mult = (opts && typeof opts.volumeMult === 'number') ? opts.volumeMult
                 : (this._gainOverrides[name] != null ? this._gainOverrides[name] : 1);
      a.volume = Math.max(0, Math.min(1, this.volume * mult));
      a.play().catch(() => { /* autoplay or load error — silent fail */ });
      return a;
    } catch (e) { return null; }
  },

  // Start (or replace) the single looping background track.
  // fadeIn = true → ramps from 0 to current volume over ~800ms.
  playBgm(name, { fadeIn = true } = {}) {
    if (!this._userInteracted) return;
    const src = SOUNDS[name];
    if (!src) { console.warn('SoundManager.playBgm unknown:', name); return; }
    // Already playing this BGM? Don't restart.
    if (this.currentBgm && this.currentBgm.name === name) return;
    // Stop any current BGM first (with fade)
    if (this.currentBgm) this.stopBgm(true);
    try {
      const a = new Audio(src);
      a.loop = true;
      a.volume = fadeIn ? 0 : (this.muted ? 0 : this.volume);
      this.currentBgm = { name, audio: a };
      a.play().catch(() => {});
      if (fadeIn) this._fadeTo(a, this.muted ? 0 : this.volume, 800);
    } catch (e) {}
  },

  // Stop the current BGM. fade=true (default) ramps down over ~800ms.
  stopBgm(fade = true) {
    const cur = this.currentBgm;
    if (!cur) return;
    this.currentBgm = null;
    if (!fade) { try { cur.audio.pause(); cur.audio.src = ''; } catch (e) {} return; }
    this._fadeTo(cur.audio, 0, 800, () => { try { cur.audio.pause(); cur.audio.src = ''; } catch (e) {} });
  },

  // Play a vocal sting at full volume layered with a background at 35%.
  // Both fire once (no loop). Used for victory and defeat — both start at the same time.
  playLayered(stingName, bgmName) {
    if (!this._userInteracted) return;
    this.stopLayered(false); // clear any previous layered audio without fade
    const stingSrc = SOUNDS[stingName];
    const bgmSrc   = SOUNDS[bgmName];
    if (!stingSrc || !bgmSrc) return;
    try {
      const sting = new Audio(stingSrc);
      const bg    = new Audio(bgmSrc);
      sting.volume = this.muted ? 0 : this.volume;            // 100% of master
      bg.volume    = this.muted ? 0 : this.volume * 0.35;     // 35% of master
      bg.loop      = false;                                    // play once, don't loop
      this.layeredSting = { name: stingName, audio: sting };
      this.layeredBgm   = { name: bgmName,   audio: bg };
      // Start simultaneously
      const startStingPromise = sting.play();
      const startBgPromise    = bg.play();
      if (startStingPromise) startStingPromise.catch(() => {});
      if (startBgPromise)    startBgPromise.catch(() => {});
    } catch (e) {}
  },

  // Stop the layered victory/defeat audio. fade=true (default) ramps both down over 1s.
  stopLayered(fade = true) {
    const sting = this.layeredSting, bg = this.layeredBgm;
    this.layeredSting = null;
    this.layeredBgm = null;
    const kill = (entry) => {
      if (!entry) return;
      if (!fade) { try { entry.audio.pause(); entry.audio.src = ''; } catch (e) {} return; }
      this._fadeTo(entry.audio, 0, 1000, () => { try { entry.audio.pause(); entry.audio.src = ''; } catch (e) {} });
    };
    kill(sting);
    kill(bg);
  },

  // Stop EVERYTHING (used by mute toggle and resetSession).
  stopAll(fade = false) {
    this.stopBgm(fade);
    this.stopLayered(fade);
  },

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    try { localStorage.setItem('ashbound_volume', String(this.volume)); } catch (e) {}
    // Live-update any currently playing audio
    if (this.currentBgm && !this.muted) this.currentBgm.audio.volume = this.volume;
    if (this.layeredSting && !this.muted) this.layeredSting.audio.volume = this.volume;
    if (this.layeredBgm   && !this.muted) this.layeredBgm.audio.volume   = this.volume * 0.35;
  },

  setMuted(m) {
    this.muted = !!m;
    try { localStorage.setItem('ashbound_muted', this.muted ? '1' : '0'); } catch (e) {}
    if (this.muted) {
      // Mute everything live
      if (this.currentBgm)   this.currentBgm.audio.volume = 0;
      if (this.layeredSting) this.layeredSting.audio.volume = 0;
      if (this.layeredBgm)   this.layeredBgm.audio.volume = 0;
    } else {
      if (this.currentBgm)   this.currentBgm.audio.volume = this.volume;
      if (this.layeredSting) this.layeredSting.audio.volume = this.volume;
      if (this.layeredBgm)   this.layeredBgm.audio.volume = this.volume * 0.35;
    }
  },

  toggleMuted() { this.setMuted(!this.muted); return this.muted; },

  // ── private ──
  _fadeTo(audio, targetVol, durationMs, onComplete) {
    if (!audio) return;
    const startVol = audio.volume;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / durationMs);
      try { audio.volume = startVol + (targetVol - startVol) * t; } catch (e) {}
      if (t < 1) requestAnimationFrame(step);
      else if (onComplete) onComplete();
    };
    requestAnimationFrame(step);
  },
};

// Restore prefs immediately (before any other script tries to play audio)
SoundManager.init();
