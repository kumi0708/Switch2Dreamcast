/*
 * Dreamcast for Brewser — a small libretro frontend for the Flycast WASM core.
 *
 * Runs on the Brewser runtime (Nintendo Switch) and in any modern desktop browser.
 * The core (core/flycast_libretro.js + .wasm) is Flycast (GPLv2) built for the
 * EmulatorJS RetroArch layer, so the JS<->core contract mirrors EmulatorJS:
 *   - EJS_Runtime(moduleArgs) -> Module (MODULARIZE)
 *   - Module.callbacks.setupCoreSettingFile(path)  (core asks for its .opt file)
 *   - Module._simulate_input(player, id, value)    (libretro joypad ids, analog 16-23)
 *   - Module.callMain(["/game.cdi"])
 */
(function () {
  'use strict';

  // ───────────────────────── environment ─────────────────────────
  const UA = (navigator.userAgent || '');
  const IS_BREWSER = /switch-web|brewser|nx\.js/i.test(UA) || typeof globalThis.Switch !== 'undefined';
  const HAS_LS = (() => { try { return !!window.localStorage; } catch (e) { return false; } })();
  const DEBUG = /[?&]debug/.test(location.search);

  const $ = (id) => document.getElementById(id);
  const ui = {
    launcher: $('launcher'), emu: $('emu'), list: $('gamelist'), empty: $('emptyHint'),
    status: $('status'), bios: $('biosStatus'), canvas: $('canvas'), wrap: $('canvasWrap'),
    osd: $('osd'), loading: $('loading'), loadingText: $('loadingText'),
    webTools: $('webTools'), fileInput: $('fileInput'),
  };

  const log = (...a) => { try { console.log('[dc]', ...a); } catch (e) {} };
  const setStatus = (msg, isErr) => { ui.status.textContent = msg; ui.status.classList.toggle('error', !!isErr); log(msg); };
  const setLoading = (msg) => { ui.loadingText.textContent = msg; };

  // ───────────────────────── settings ─────────────────────────
  const OPTS = {
    bios:    { values: ['auto', 'real', 'hle'],         label: (v) => v },
    layout:  { values: ['positional', 'label'],        label: (v) => v },
    res:     { values: ['640x480', '960x720', '1280x960'], label: (v) => v },
    skip:    { values: ['on', 'off'],                  label: (v) => v },
    region:  { values: ['Japan', 'USA', 'Europe'],     label: (v) => v },
    stretch: { values: ['4:3', 'stretch'],             label: (v) => v },
  };
  const settings = Object.fromEntries(Object.keys(OPTS).map((k) => [k, OPTS[k].values[0]]));
  const SETTINGS_KEY = 'dc4b.settings';
  try { if (HAS_LS) Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) {}
  function saveSettings() { try { if (HAS_LS) localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }
  function cycleSetting(key) {
    const vals = OPTS[key].values;
    settings[key] = vals[(vals.indexOf(settings[key]) + 1) % vals.length];
    saveSettings(); renderSettings();
  }
  function renderSettings() {
    for (const btn of document.querySelectorAll('.toggle')) {
      const k = btn.getAttribute('data-key');
      btn.textContent = OPTS[k].label(settings[k]);
    }
  }
  for (const btn of document.querySelectorAll('.toggle')) {
    btn.addEventListener('click', () => cycleSetting(btn.getAttribute('data-key')));
  }
  renderSettings();

  // ───────────────────────── fetch helpers ─────────────────────────
  /** Fetch a URL into a Uint8Array. Streams when the runtime supports it. */
  async function fetchBytes(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (res.body && typeof res.body.getReader === 'function') {
      try {
        const reader = res.body.getReader();
        const chunks = []; let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); got += value.length;
          if (onProgress) onProgress(got, total);
        }
        const out = new Uint8Array(got); let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        return out;
      } catch (e) { log('stream read failed, falling back to arrayBuffer', e); }
    }
    const buf = await res.arrayBuffer();
    if (onProgress) onProgress(buf.byteLength, buf.byteLength);
    return new Uint8Array(buf);
  }
  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
  const fmtMB = (n) => (n / 1048576).toFixed(1) + ' MB';

  // ───────────────────────── game list ─────────────────────────
  let games = [];      // { title, file, as?, launch?, blob? (File) }
  let selected = 0;

  function renderList() {
    ui.list.innerHTML = '';
    ui.empty.style.display = games.length ? 'none' : 'block';
    games.forEach((g, i) => {
      const li = document.createElement('li');
      li.className = i === selected ? 'selected' : '';
      const t = document.createElement('span'); t.className = 'title'; t.textContent = g.title;
      const f = document.createElement('span'); f.className = 'file'; f.textContent = g.file;
      li.appendChild(t); li.appendChild(f);
      li.addEventListener('click', () => { selected = i; renderList(); });
      li.addEventListener('dblclick', () => { selected = i; startSelected(); });
      ui.list.appendChild(li);
    });
    const el = ui.list.children[selected];
    if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
  }
  function moveSelection(d) {
    if (!games.length) return;
    selected = (selected + d + games.length) % games.length;
    renderList();
  }
  function startSelected() {
    if (!games.length || state.phase !== 'launcher') return;
    startGame(games[selected]).catch((e) => {
      log(e);
      ui.emu.style.display = 'none'; ui.launcher.style.display = 'flex';
      state.phase = 'launcher';
      setStatus('起動に失敗: ' + (e && e.message ? e.message : e), true);
    });
  }

  async function loadGameList() {
    try {
      const j = await fetchJSON('games/games.json');
      games = (j.games || []).filter((g) => g && g.file).map((g) => ({
        title: g.title || g.file, file: g.file, as: g.as || null, launch: g.launch || null,
      }));
    } catch (e) {
      log('games.json not readable', e);
      games = [];
    }
    renderList();
  }

  // Web-only: open local files (not available on Brewser — it has no file picker for apps).
  if (!IS_BREWSER && ui.fileInput) {
    ui.webTools.style.display = 'block';
    ui.fileInput.addEventListener('change', () => {
      const files = Array.from(ui.fileInput.files || []);
      if (!files.length) return;
      const primary = files.find((f) => /\.(cue|gdi|chd|cdi|elf|iso|zip)$/i.test(f.name)) || files[0];
      games.push({ title: primary.name, file: files.length > 1 ? `${files.length} files` : primary.name, blobs: files, launch: primary.name });
      selected = games.length - 1; renderList();
    });
  }

  // ───────────────────────── BIOS ─────────────────────────
  const bios = { boot: null, flash: null };
  async function loadBios() {
    ui.bios.className = 'pill pill-unknown'; ui.bios.textContent = 'BIOS: checking…';
    try {
      bios.boot = await fetchBytes('bios/dc_boot.bin');
      bios.flash = await fetchBytes('bios/dc_flash.bin');
      if (bios.boot.length < 1024 * 1024 || bios.flash.length < 65536) throw new Error('bad size');
      ui.bios.className = 'pill pill-ok'; ui.bios.textContent = 'BIOS: found (dc_boot.bin + dc_flash.bin)';
    } catch (e) {
      bios.boot = bios.flash = null;
      ui.bios.className = 'pill pill-warn'; ui.bios.textContent = 'BIOS: not found → HLE BIOS';
    }
  }
  const useHle = () => settings.bios === 'hle' || (settings.bios === 'auto' && !bios.boot);

  // ───────────────────────── core options ─────────────────────────
  function coreOptions() {
    const o = {
      // Tuned defaults from nasomers/flycast-wasm config/dreamcast-core-options.json
      reicast_boot_to_bios: 'disabled',
      reicast_hle_bios: useHle() ? 'enabled' : 'disabled',
      reicast_threaded_rendering: 'disabled',
      reicast_synchronous_rendering: 'disabled',
      reicast_internal_resolution: settings.res,
      reicast_mipmapping: 'disabled',
      reicast_anisotropic_filtering: '1',
      reicast_texupscale: 'disabled',
      reicast_enable_rttb: 'disabled',
      reicast_enable_purupuru: 'disabled',
      reicast_alpha_sorting: 'per-strip (fast, least accurate)',
      reicast_delay_frame_swapping: 'disabled',
      reicast_frame_skipping: settings.skip === 'on' ? 'enabled' : 'disabled',
      reicast_auto_skip_frame: settings.skip === 'on' ? 'normal' : 'disabled',
      reicast_framerate: 'normal',
      reicast_region: settings.region,
      reicast_language: settings.region === 'Japan' ? 'Japanese' : 'English',
      reicast_cable_type: 'TV (VBS/Y+S/C)',
      reicast_broadcast: settings.region === 'Europe' ? 'PAL_E' : 'NTSC',
      reicast_digital_triggers: 'disabled',
      reicast_gdrom_fast_loading: 'enabled',
      reicast_per_content_vmus: 'disabled',
      reicast_vmu1_screen_display: 'disabled',
      reicast_enable_dsp: 'enabled',
    };
    return Object.entries(o).map(([k, v]) => `${k} = "${v}"\n`).join('');
  }
  function retroarchCfg() {
    return [
      'autosave_interval = 60',
      'screenshot_directory = "/"',
      'block_sram_overwrite = false',
      'video_gpu_screenshot = false',
      'audio_latency = 64',
      'video_vsync = true',
      'video_smooth = true',
      'video_font_enable = false',
      'fastforward_ratio = 3.0',
      'slowmotion_ratio = 3.0',
      'system_directory = "/"',
      'savefile_directory = "/data/saves"',
      'savestate_directory = "/data/states"',
      'menu_driver = "null"',
      'video_message_pos_x = 0.05',
      'video_fullscreen = false',
      '',
    ].join('\n');
  }

  // ───────────────────────── WebGL fix-ups ─────────────────────────
  // The core's glGetString() falls back to getParameter(name) for anything it
  // doesn't special-case.  RetroArch's GL driver asks for GL_EXTENSIONS (0x1F03),
  // which is not a valid getParameter() pname on WebGL2 → GL_INVALID_ENUM →
  // "[GL] GL: Invalid enum. Cannot open video driver".  Answer that query from
  // getSupportedExtensions() instead so no error is recorded.
  const GL_EXTENSIONS = 0x1F03;
  function patchGLContext(gl) {
    if (!gl || gl.__dc4bPatched) return gl;
    const getParameter = gl.getParameter;
    gl.getParameter = function (pname) {
      if (pname === GL_EXTENSIONS) {
        let exts = [];
        try { exts = this.getSupportedExtensions() || []; } catch (e) {}
        return exts.join(' ');
      }
      return getParameter.call(this, pname);
    };
    gl.__dc4bPatched = true;
    return gl;
  }
  (function hookCanvas(canvas) {
    const proto = Object.getPrototypeOf(canvas);
    const orig = canvas.getContext;
    canvas.getContext = function (type, attrs) {
      const ctx = (orig || proto.getContext).call(this, type, attrs);
      return (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') ? patchGLContext(ctx) : ctx;
    };
  })(ui.canvas);

  // ───────────────────────── emscripten module ─────────────────────────
  const state = { phase: 'launcher', Module: null, FS: null, fns: null, game: null, saveTimer: 0 };

  function loadCoreScript() {
    return new Promise((resolve, reject) => {
      if (typeof window.EJS_Runtime === 'function') return resolve();
      const s = document.createElement('script');
      s.src = 'core/flycast_libretro.js';
      s.async = true;
      s.onload = () => (typeof window.EJS_Runtime === 'function' ? resolve() : reject(new Error('EJS_Runtime missing after load')));
      s.onerror = () => reject(new Error('failed to load core/flycast_libretro.js'));
      document.body.appendChild(s);
    });
  }

  async function createModule() {
    await loadCoreScript();
    const moduleArg = {
      noInitialRun: true,
      arguments: [],
      canvas: ui.canvas,
      parent: ui.wrap,
      callbacks: {},
      print: (m) => { if (DEBUG) log('[core]', m); },
      printErr: (m) => { if (DEBUG || /ERROR|Fatal|Aborted/.test(m)) log('[core!]', m); },
      locateFile: (f) => (f.endsWith('.wasm') ? 'core/flycast_libretro.wasm' : 'core/' + f),
      getSavExt: () => '.srm',
      // We instantiate the wasm ourselves so the missing libzip imports can be
      // pointed at lib/zipshim.js (see that file for why).
      instantiateWasm: (info, receiveInstance) => {
        const replaced = window.installZipShim(info, () => moduleArg);
        log(`zipshim: replaced ${replaced} libzip import(s)`);
        (async () => {
          const url = 'core/flycast_libretro.wasm';
          let result = null;
          if (typeof WebAssembly.instantiateStreaming === 'function') {
            try { result = await WebAssembly.instantiateStreaming(fetch(url), info); }
            catch (e) { log('instantiateStreaming failed, falling back to ArrayBuffer:', e && e.message); }
          }
          if (!result) {
            const bytes = await fetchBytes(url, (got, total) => setLoading(`Loading emulator core ${fmtMB(got)}${total ? ' / ' + fmtMB(total) : ''}`));
            result = await WebAssembly.instantiate(bytes, info);
          }
          receiveInstance(result.instance, result.module);
        })().catch((e) => { log('wasm instantiate failed', e); setStatus('WASM の初期化に失敗: ' + e.message, true); });
        return {};   // async instantiation in progress
      },
    };
    const Module = await window.EJS_Runtime(moduleArg);
    return Module;
  }

  function writeFile(FS, path, data, opts) {
    const parts = path.split('/'); let cur = '';
    for (let i = 1; i < parts.length - 1; i++) {
      cur += '/' + parts[i];
      try { FS.mkdir(cur); } catch (e) {}
    }
    FS.writeFile(path, data, opts);   // opts.canOwn lets MEMFS keep the buffer instead of copying it
  }
  function mkdirp(FS, path) {
    const parts = path.split('/'); let cur = '';
    for (let i = 1; i < parts.length; i++) { cur += '/' + parts[i]; try { FS.mkdir(cur); } catch (e) {} }
  }

  // ───────────────────────── save persistence (localStorage) ─────────────────────────
  const SAVE_DIRS = ['/data/saves', '/dc'];
  const SAVE_PREFIX = 'dc4b.save:';
  function b64enc(u8) {
    let s = ''; const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  function b64dec(s) { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function restoreSaves(FS) {
    if (!HAS_LS) return 0;
    let n = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(SAVE_PREFIX)) continue;
        const path = k.slice(SAVE_PREFIX.length);
        if (path.startsWith('/dc/dc_boot') || path.startsWith('/dc/dc_flash')) continue;
        writeFile(FS, path, b64dec(localStorage.getItem(k)));
        n++;
      }
    } catch (e) { log('restoreSaves failed', e); }
    return n;
  }
  function persistSaves() {
    const FS = state.FS; if (!FS || !HAS_LS) return;
    try { if (state.fns && state.fns.saveFiles) state.fns.saveFiles(); } catch (e) {}
    let n = 0;
    for (const dir of SAVE_DIRS) {
      let names = [];
      try { names = FS.readdir(dir); } catch (e) { continue; }
      for (const name of names) {
        if (name === '.' || name === '..') continue;
        if (/^dc_boot|^dc_flash/i.test(name)) continue;       // never persist the BIOS itself
        if (!/\.(bin|srm|sav|nvmem)$/i.test(name) && !/vmu|nvmem/i.test(name)) continue;
        const path = dir + '/' + name;
        try {
          const st = FS.stat(path); if (!FS.isFile(st.mode) || st.size > 2 * 1024 * 1024) continue;
          const data = FS.readFile(path);
          const enc = b64enc(data);
          const key = SAVE_PREFIX + path;
          if (localStorage.getItem(key) !== enc) { localStorage.setItem(key, enc); n++; }
        } catch (e) { log('persist failed for', path, e); }
      }
    }
    if (n) log(`persisted ${n} save file(s)`);
  }

  // ───────────────────────── content loading ─────────────────────────
  const DISC_PRIORITY = ['cue', 'gdi', 'chd', 'cdi', 'elf', 'iso', 'bin'];
  function pickLaunchFile(names, preferred) {
    if (preferred && names.includes(preferred)) return preferred;
    for (const ext of DISC_PRIORITY) {
      const hit = names.find((n) => n.toLowerCase().endsWith('.' + ext));
      if (hit) return hit;
    }
    return names[0];
  }
  const baseName = (p) => p.split('/').pop();

  /** Writes the game's files into the FS root and returns the path to launch. */
  async function stageGame(FS, game, progress) {
    const written = [];
    const putBytes = (name, bytes) => { writeFile(FS, '/' + name, bytes, { canOwn: true }); written.push(name); };
    const stage = (name, bytes) => {
      if (/\.zip$/i.test(name)) {
        progress(`Extracting ${name}…`);
        const files = fflate.unzipSync(bytes);
        for (const [n, b] of Object.entries(files)) { if (!n.endsWith('/')) putBytes(baseName(n), b); }
      } else {
        putBytes(name, bytes);
      }
    };
    if (game.blobs) {
      for (const f of game.blobs) {
        progress(`Reading ${f.name} (${fmtMB(f.size)})…`);
        stage(f.name, new Uint8Array(await f.arrayBuffer()));
      }
    } else {
      const url = 'games/' + game.file;
      const bytes = await fetchBytes(url, (got, total) => progress(`Loading ${game.file} ${fmtMB(got)}${total ? ' / ' + fmtMB(total) : ''}`));
      stage(game.as || game.file, bytes);
    }
    if (!written.length) throw new Error('no files staged');
    return '/' + pickLaunchFile(written, game.launch);
  }

  // ───────────────────────── start ─────────────────────────
  async function startGame(game) {
    state.phase = 'loading'; state.game = game;
    ui.launcher.style.display = 'none'; ui.emu.style.display = 'block'; ui.loading.style.display = 'flex';
    ui.wrap.className = 'canvas-wrap ' + (settings.stretch === 'stretch' ? 'fit-stretch' : 'fit-43');
    setLoading('Loading emulator core…');

    const Module = await createModule();
    const FS = Module.FS;
    state.Module = Module; state.FS = FS;
    window.EJS_emulator = { volume: 1, muted: false };   // read by the core's audio sink for volume

    Module.callbacks.setupCoreSettingFile = (path) => { log('core options →', path); writeFile(FS, path, coreOptions()); };

    // RetroArch config + directories
    writeFile(FS, '/home/web_user/.config/retroarch/retroarch.cfg', retroarchCfg());
    mkdirp(FS, '/data/saves'); mkdirp(FS, '/data/states'); mkdirp(FS, '/dc');
    // Pre-create the core's option file too (in case the callback path differs)
    writeFile(FS, '/home/web_user/retroarch/userdata/config/flycast/flycast.opt', coreOptions());

    // BIOS
    if (!useHle() && bios.boot && bios.flash) {
      setLoading('Installing BIOS…');
      writeFile(FS, '/dc/dc_boot.bin', bios.boot);
      writeFile(FS, '/dc/dc_flash.bin', bios.flash);
    }
    const restored = restoreSaves(FS);
    if (restored) log(`restored ${restored} save file(s) from localStorage`);

    // Game files
    const launchPath = await stageGame(FS, game, setLoading);
    log('launching', launchPath);

    state.fns = {
      simulateInput: Module.cwrap('simulate_input', null, ['number', 'number', 'number']),
      saveFiles: Module.cwrap('cmd_savefiles', null, []),
      restart: Module.cwrap('system_restart', null, []),
      toggleMainLoop: Module.cwrap('toggleMainLoop', null, ['number']),
      setVariable: Module.cwrap('ejs_set_variable', null, ['string', 'string']),
    };

    setLoading('Booting Dreamcast…');
    ui.canvas.focus();
    Module.callMain(DEBUG ? ['-v', launchPath] : [launchPath]);
    state.phase = 'running';
    startInput();
    // Hide the loading overlay after the first few frames have had a chance to render.
    setTimeout(() => { ui.loading.style.display = 'none'; }, 1500);
    if (state.saveTimer) clearInterval(state.saveTimer);
    state.saveTimer = setInterval(persistSaves, 30000);
    showOsd(`${game.title} — ${useHle() ? 'HLE BIOS' : 'BIOS'} — ${settings.res}`, 3000);
  }

  function exitToLauncher() {
    if (state.phase !== 'running') return;
    state.phase = 'exiting';
    try { persistSaves(); } catch (e) {}
    // The Emscripten runtime can't be cleanly torn down and re-created; reload the page.
    setTimeout(() => location.reload(), 100);
  }

  let osdTimer = 0;
  function showOsd(text, ms) {
    ui.osd.textContent = text; ui.osd.style.display = 'block';
    clearTimeout(osdTimer); osdTimer = setTimeout(() => { ui.osd.style.display = 'none'; }, ms || 2000);
  }

  // ───────────────────────── input ─────────────────────────
  // libretro joypad ids
  const B = 0, Y = 1, SELECT = 2, START = 3, UP = 4, DOWN = 5, LEFT = 6, RIGHT = 7, A = 8, X = 9,
        L = 10, R = 11, L2 = 12, R2 = 13, L3 = 14, R3 = 15;
  // analog: 16 LX+, 17 LX-, 18 LY+, 19 LY-, 20 RX+, 21 RX-, 22 RY+, 23 RY-
  const AXIS_MAX = 0x7fff, DEADZONE = 0.15;

  // Standard-gamepad button index -> libretro id.
  // Chrome/standard: 0 bottom, 1 right, 2 left, 3 top.   Brewser: 0 A(right), 1 B(bottom), 2 X(top), 3 Y(left).
  function buildPadMap() {
    const m = new Array(16).fill(-1);
    const positional = settings.layout === 'positional';
    if (IS_BREWSER) {
      // index: 0=A 1=B 2=X 3=Y (Switch labels)
      if (positional) { m[1] = A; m[0] = B; m[3] = X; m[2] = Y; }   // same physical positions as the DC pad
      else            { m[0] = A; m[1] = B; m[2] = X; m[3] = Y; }   // same letters
    } else {
      // standard mapping: 0=bottom 1=right 2=left 3=top  (Xbox A B X Y)
      if (positional) { m[0] = A; m[1] = B; m[2] = X; m[3] = Y; }
      else            { m[0] = B; m[1] = A; m[2] = Y; m[3] = X; }   // Switch Pro in Chrome reports Xbox layout; "label" swaps
    }
    m[4] = L; m[5] = R; m[6] = L2; m[7] = R2;
    m[8] = IS_BREWSER ? START : SELECT;   // Minus = Start on Brewser (Plus is reserved by the shell)
    m[9] = START;
    m[10] = L3; m[11] = R3;
    m[12] = UP; m[13] = DOWN; m[14] = LEFT; m[15] = RIGHT;
    return m;
  }

  const KEYMAP = {
    KeyZ: A, KeyX: B, KeyA: X, KeyS: Y, Enter: START, ShiftRight: SELECT, Backspace: SELECT,
    ArrowUp: UP, ArrowDown: DOWN, ArrowLeft: LEFT, ArrowRight: RIGHT,
    KeyQ: L2, KeyE: R2, Tab: L, KeyR: R,
    KeyH: 16, KeyF: 17, KeyG: 18, KeyT: 19,
  };
  // Fallback by `key` for runtimes/soft keyboards that don't fill in `code`.
  const KEYMAP_BY_KEY = {
    z: A, x: B, a: X, s: Y, enter: START, shift: SELECT, backspace: SELECT,
    arrowup: UP, arrowdown: DOWN, arrowleft: LEFT, arrowright: RIGHT,
    q: L2, e: R2, tab: L, r: R, h: 16, f: 17, g: 18, t: 19, escape: -1,
  };
  function keyToId(e) {
    if (e.code && KEYMAP[e.code] !== undefined) return KEYMAP[e.code];
    if (e.code === 'Escape') return -1;
    const k = (e.key || '').toLowerCase();
    return KEYMAP_BY_KEY[k];
  }

  const inputState = [];   // per player: array(24) of current values
  function setInput(player, id, value) {
    const p = inputState[player] || (inputState[player] = new Array(24).fill(0));
    if (p[id] === value) return;
    p[id] = value;
    if (state.fns) state.fns.simulateInput(player, id, value);
  }

  let inputRunning = false;
  function startInput() {
    if (inputRunning) return;
    inputRunning = true;
    const padMap = buildPadMap();
    const prevButtons = [];
    function poll() {
      if (state.phase !== 'running') { inputRunning = false; return; }
      let pads = [];
      try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) {}
      let player = 0;
      for (let gi = 0; gi < pads.length && player < 4; gi++) {
        const gp = pads[gi]; if (!gp || !gp.connected) continue;
        const btns = gp.buttons || [];
        for (let b = 0; b < 16 && b < btns.length; b++) {
          const id = padMap[b]; if (id < 0) continue;
          const pressed = typeof btns[b] === 'object' ? (btns[b].pressed || btns[b].value > 0.5) : btns[b] > 0.5;
          if (id === L2 || id === R2) {
            const v = typeof btns[b] === 'object' ? btns[b].value : btns[b];
            setInput(player, id, pressed ? 1 : 0);
            void v;
          } else {
            setInput(player, id, pressed ? 1 : 0);
          }
        }
        const ax = gp.axes || [];
        const axisPair = (a, posId, negId) => {
          let v = ax[a] || 0; if (Math.abs(v) < DEADZONE) v = 0;
          const mag = Math.min(1, (Math.abs(v) - DEADZONE) / (1 - DEADZONE)) * AXIS_MAX | 0;
          setInput(player, posId, v > 0 ? mag : 0);
          setInput(player, negId, v < 0 ? mag : 0);
        };
        axisPair(0, 16, 17); axisPair(1, 18, 19); axisPair(2, 20, 21); axisPair(3, 22, 23);
        // Left stick also drives the D-pad for homebrew that only reads digital input? No — keep them separate (DC has both).
        prevButtons[gi] = btns;
        player++;
      }
      requestAnimationFrame(poll);
    }
    requestAnimationFrame(poll);
  }

  window.addEventListener('keydown', (e) => {
    if (state.phase === 'launcher') return launcherKey(e);
    if (state.phase !== 'running') return;
    const id = keyToId(e); if (id === undefined) return;
    e.preventDefault();
    if (id === -1) { exitToLauncher(); return; }
    setInput(0, id, id >= 16 ? AXIS_MAX : 1);
  });
  window.addEventListener('keyup', (e) => {
    if (state.phase !== 'running') return;
    const id = keyToId(e); if (id === undefined || id < 0) return;
    e.preventDefault(); setInput(0, id, 0);
  });

  // ───────────────────────── launcher navigation (keyboard + gamepad) ─────────────────────────
  function launcherKey(e) {
    const k = e.code || e.key;
    switch (k) {
      case 'ArrowUp': e.preventDefault(); moveSelection(-1); break;
      case 'ArrowDown': e.preventDefault(); moveSelection(1); break;
      case 'Enter': case 'Space': case ' ': e.preventDefault(); startSelected(); break;
    }
  }
  (function launcherPad() {
    let last = {};
    let repeatAt = 0;
    function poll() {
      if (state.phase === 'launcher') {
        let pads = [];
        try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) {}
        const now = performance.now();
        for (const gp of pads) {
          if (!gp || !gp.connected) continue;
          const b = gp.buttons; const ax = gp.axes || [];
          const down = (i) => !!(b[i] && (b[i].pressed || b[i].value > 0.5));
          const up = down(12) || (ax[1] || 0) < -0.5, dn = down(13) || (ax[1] || 0) > 0.5;
          const confirm = IS_BREWSER ? down(0) : down(0);   // A (Brewser index 0 = A; standard index 0 = bottom)
          const k = gp.index;
          const prev = last[k] || {};
          if (up && (!prev.up || now > repeatAt)) { moveSelection(-1); repeatAt = now + (prev.up ? 120 : 400); }
          if (dn && (!prev.dn || now > repeatAt)) { moveSelection(1); repeatAt = now + (prev.dn ? 120 : 400); }
          if (confirm && !prev.confirm) startSelected();
          last[k] = { up, dn, confirm };
        }
      }
      requestAnimationFrame(poll);
    }
    requestAnimationFrame(poll);
  })();

  // ───────────────────────── lifecycle ─────────────────────────
  window.addEventListener('pagehide', persistSaves);
  window.addEventListener('beforeunload', persistSaves);
  document.addEventListener('visibilitychange', () => { if (document.hidden) persistSaves(); });

  // ───────────────────────── boot ─────────────────────────
  (async function main() {
    log('Dreamcast for Brewser — env:', IS_BREWSER ? 'Brewser' : 'web', UA);
    await Promise.all([loadGameList(), loadBios()]);
    setStatus(games.length ? `${games.length} 本のゲーム。A / Enter で起動。` : 'ゲームが登録されていません。');
    // Warm the core script in the background so the first launch is faster.
    loadCoreScript().catch((e) => setStatus('コアの読み込みに失敗: ' + e.message, true));
  })();

  // exposed for debugging
  window.dc4b = { state, settings, persistSaves, games: () => games, start: startSelected };
})();
