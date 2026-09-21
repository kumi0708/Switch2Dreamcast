/*
 * zipshim.js — a tiny in-JS implementation of the libzip functions that Flycast's
 * ZipArchive.cpp uses.  The prebuilt flycast_libretro.wasm was linked with
 * `-Wl,--allow-undefined` and no libzip, so those imports abort with
 * "missing function".  Flycast needs them for its embedded, zip-compressed
 * resources (HLE BIOS font, i18n, Naomi flash defaults).  We back them with
 * fflate and hand the stubs' import slots to these implementations from the
 * Module.instantiateWasm hook.
 *
 * Only in-memory sources (zip_source_buffer_create) are supported; file-based
 * sources (zip_source_filep_create) return NULL so callers fail gracefully.
 *
 * Calling convention notes (wasm32, -sWASM_BIGINT):
 *   zip_uint64_t / zip_int64_t / time_t parameters and returns are BigInt.
 *   Handles are opaque non-zero integers (the C++ side only passes them back).
 */
(function () {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();
  function crc32(u8) {
    let c = -1;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  // struct zip_stat (wasm32): valid@0(u64) name@8(ptr) index@16(u64) size@24(u64)
  //   comp_size@32(u64) mtime@40(i64) crc@48(u32) comp_method@52(u16) enc@54(u16) flags@56(u32)
  const ZIP_STAT_NAME = 1n, ZIP_STAT_INDEX = 2n, ZIP_STAT_SIZE = 4n, ZIP_STAT_COMP_SIZE = 8n,
        ZIP_STAT_MTIME = 16n, ZIP_STAT_CRC = 32n, ZIP_STAT_COMP_METHOD = 64n;

  function install(info, getModule) {
    const M = () => getModule();
    const heap = () => M().HEAPU8;
    const dv = () => new DataView(M().HEAPU8.buffer);

    let nextId = 1;
    const sources = new Map();   // id -> Uint8Array
    const archives = new Map();  // id -> { entries: [{name, data, crc, namePtr}] }
    const files = new Map();     // id -> { entry, pos }

    const cstr = (ptr) => M().UTF8ToString(ptr);
    function namePtr(entry) {
      if (entry.namePtr) return entry.namePtr;
      const n = M().lengthBytesUTF8(entry.name) + 1;
      const p = M()._malloc(n);
      M().stringToUTF8(entry.name, p, n);
      entry.namePtr = p;
      return p;
    }
    function fillStat(st, entry, index) {
      if (entry.crc === undefined) entry.crc = crc32(entry.data);
      const d = dv();
      d.setBigUint64(st + 0, ZIP_STAT_NAME | ZIP_STAT_INDEX | ZIP_STAT_SIZE | ZIP_STAT_COMP_SIZE | ZIP_STAT_MTIME | ZIP_STAT_CRC | ZIP_STAT_COMP_METHOD, true);
      d.setUint32(st + 8, namePtr(entry), true);
      d.setBigUint64(st + 16, BigInt(index), true);
      d.setBigUint64(st + 24, BigInt(entry.data.length), true);
      d.setBigUint64(st + 32, BigInt(entry.data.length), true);
      d.setBigInt64(st + 40, 0n, true);
      d.setUint32(st + 48, entry.crc, true);
      d.setUint16(st + 52, 0, true);
      d.setUint16(st + 54, 0, true);
      d.setUint32(st + 56, 0, true);
      return 0;
    }

    const impl = {
      _zip_source_buffer_create(data, len, freep, error) {
        const n = Number(len);
        const bytes = heap().slice(data, data + n);   // copy: the caller may free/reuse the buffer
        const id = nextId++;
        sources.set(id, bytes);
        return id;
      },
      _zip_source_filep_create(file, start, len, error) {
        return 0;   // unsupported (needs libc FILE* plumbing); callers treat NULL as failure
      },
      _zip_source_free(src) { sources.delete(src); },
      _zip_open_from_source(src, flags, error) {
        const bytes = sources.get(src);
        if (!bytes) return 0;
        let unzipped;
        try { unzipped = fflate.unzipSync(bytes); } catch (e) { console.warn('[zipshim] unzip failed', e); return 0; }
        const entries = [];
        for (const [name, data] of Object.entries(unzipped)) {
          if (name.endsWith('/')) continue;
          entries.push({ name, data });
        }
        const id = nextId++;
        archives.set(id, { entries });
        sources.delete(src);   // zip_open_from_source takes ownership of the source
        return id;
      },
      _zip_close(za) { archives.delete(za); return 0; },
      _zip_get_num_entries(za, flags) {
        const a = archives.get(za);
        return a ? BigInt(a.entries.length) : -1n;
      },
      _zip_fopen(za, namePtr_, flags) {
        const a = archives.get(za); if (!a) return 0;
        const name = cstr(namePtr_);
        const entry = a.entries.find((e) => e.name === name);
        if (!entry) return 0;
        const id = nextId++; files.set(id, { entry, pos: 0 }); return id;
      },
      _zip_fopen_index(za, index, flags) {
        const a = archives.get(za); if (!a) return 0;
        const entry = a.entries[Number(index)];
        if (!entry) return 0;
        const id = nextId++; files.set(id, { entry, pos: 0 }); return id;
      },
      _zip_fread(zf, buf, nbytes) {
        const f = files.get(zf); if (!f) return -1n;
        const want = Number(nbytes);
        const n = Math.min(want, f.entry.data.length - f.pos);
        if (n > 0) heap().set(f.entry.data.subarray(f.pos, f.pos + n), buf);
        f.pos += n;
        return BigInt(n);
      },
      _zip_fclose(zf) { files.delete(zf); return 0; },
      _zip_stat(za, namePtr_, flags, st) {
        const a = archives.get(za); if (!a) return -1;
        const name = cstr(namePtr_);
        const idx = a.entries.findIndex((e) => e.name === name);
        if (idx < 0) return -1;
        return fillStat(st, a.entries[idx], idx);
      },
      _zip_stat_index(za, index, flags, st) {
        const a = archives.get(za); if (!a) return -1;
        const entry = a.entries[Number(index)];
        if (!entry) return -1;
        return fillStat(st, entry, Number(index));
      },
    };

    // Replace the abort() stubs in every import module by function name.
    let replaced = 0;
    for (const modName of Object.keys(info)) {
      const mod = info[modName];
      if (!mod || typeof mod !== 'object') continue;
      for (const key of Object.keys(mod)) {
        const fn = mod[key];
        if (typeof fn !== 'function') continue;
        const name = fn.name || '';
        if (impl[name] && (fn.stub || /missing function/.test(String(fn)))) {
          mod[key] = impl[name];
          replaced++;
        }
      }
    }
    return replaced;
  }

  window.installZipShim = install;
})();
