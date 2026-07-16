# Luxinus

A **fully local**, on-device AI photo editor — a Lightroom alternative. RAW editing plus AI features (denoise, upscale, masking, object removal) all run on your machine. **Photo data never leaves the device.**

> Status: **Phase 4 — presets complete.** Save the current look as a named **preset** (JSON), apply/delete it, each shown as a **live thumbnail of the current photo** rendered through the shared edit shader. **Import Lightroom `.xmp`** presets — the `crs:` namespace is mapped onto Luxinus parameters (tone, colour, tone curve, 8-channel HSL, detail, vignette) with an import summary listing what mapped and what isn't supported, and an *"approximate mapping"* notice. Builds on Phase 3 (export), Phase 2 (editing), Phase 1 (library + RAW), Phase 0 (local-only shell).

## Tech stack

| Concern | Choice |
| --- | --- |
| Shell | Electron + electron-builder (Windows NSIS / macOS dmg) |
| Frontend | React 18 · TypeScript · Vite · Zustand · Tailwind CSS |
| AI inference *(Phase 5+)* | onnxruntime-node — DirectML/CUDA (Win), CoreML (mac), CPU fallback |
| RAW decode | **libraw-wasm** (LibRaw compiled to WASM) in a hidden Chromium decode window |
| Image processing | **sharp** (libvips) — resize, webp, JPEG/PNG/TIFF/HEIF |
| Thumbnail cache | **better-sqlite3** + webp |
| Preset parsing *(Phase 4)* | fast-xml-parser (Lightroom `.xmp`) |
| EXIF *(Phase 3)* | exiftool-vendored |

Dependencies are added only in the phase that first needs them, so the tree always builds cleanly. Phase 1 added `sharp`, `libraw-wasm`, and `better-sqlite3` (see justifications at the bottom).

### Native modules & Electron ABI

`better-sqlite3` is a native addon and must be built against Electron's ABI, not the host Node's. This is wired via electron-builder:

```bash
npx electron-builder install-app-deps   # rebuilds native deps for the installed Electron
```

`sharp` (N-API, ABI-stable) needs no rebuild.

### Why RAW decodes in a hidden window, not the utility process

`libraw-wasm` is a **browser** build: it spins up a Web Worker and loads its `.wasm` via `fetch`/`XMLHttpRequest`, neither of which works in Electron's Node utility process (verified failing across 11 manufacturer RAWs). So RAW decode runs in a dedicated **offscreen Chromium "decode window"** — libraw-wasm's native environment — orchestrated by main:

```
UI window (connect-src 'none')         ← never sees RAW bytes
  requestProxy ─▶ main ─▶ decode worker (scan · sharp · SQLite cache)
                              │ host:decodeRaw
                              ▼
                       main ─▶ hidden decode window (libraw-wasm)  → RGB / embedded JPEG
                              ▼
                       decode worker: sharp resize → webp → cache → UI
```

The decode window is served over a privileged `lux://` protocol (so its wasm `fetch` works under `file://` in production) on its **own session** with `connect-src 'self'` — still strictly local (same-origin only, nothing leaves the device); the UI window keeps `connect-src 'none'`. Graceful fallback: if a camera is too new for this LibRaw build to demosaic, the embedded JPEG preview is used so the photo still displays.

## Local-only guarantees (enforced now)

- **Strict CSP**: the renderer runs under `default-src 'self'` and `connect-src 'none'`. The shipped `index.html` hard-codes this (reliable for the packaged `file://` renderer); the main process also sets it as a header. In **dev only**, an `apply: 'serve'` Vite plugin relaxes `connect-src` for HMR — production stays literally `connect-src 'none'`.
- **Sandboxed renderer**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The renderer's only capability is the narrow typed `window.luxinus` bridge in the preload.
- **Navigation lockdown**: the main process blocks any navigation/popup to a remote origin; external links open in the OS browser.
- **No publish provider** configured (`publish: null`). The only network-capable path is an optional, user-initiated update check that sends no user data (stubbed in Phase 0).

Verify the guarantee at any time:

```bash
# Should print connect-src 'none' in the built renderer, and NO occurrence in dist that weakens it.
grep -R "connect-src 'none'" src/renderer/index.html
```

## Project structure

```
src/
  main/       index.ts (windows + CSP + nav lockdown), ipc.ts (app/update),
              library.ts (forks the decode worker; bridges renderer ⇄ worker ⇄ window),
              decode-window.ts (lux:// protocol + hidden Chromium RAW decode window)
  preload/    index.ts (UI bridge), decoder.ts (decode-window bridge)
  workers/    decode.worker.ts (scan · sharp resize/encode · proxy · thumbs · cache),
              onnx.worker.ts (utilityProcess stub, Phase 5)
  shared/     ipc-channels.ts, library.ts  (typed contracts shared by all layers)
  renderer/   index.html + src/ (React UI); decoder.html + src/decoder (libraw-wasm)
```

Heavy work (RAW decode, ONNX inference, export) runs in **utility processes**, never on the main or renderer thread.

## Scripts

```bash
npm install        # install Phase 0 deps
npm run dev        # launch the app with HMR
npm run build      # type-check + build main/preload/renderer to out/
npm run typecheck  # tsc for both node and web projects
npm run dist:mac   # package a macOS .dmg
npm run dist:win   # package a Windows NSIS installer
```

## Design system — "Liquid Glass × Black / Hot Pink"

- Floating glass **panels overlay a full-bleed photo stage**, so the frosted `blur(32px)` genuinely refracts the image beneath. Matte, not glossy — no Aero specular streak.
- **Pink is a hairline, not a fill** (`#FF2D78` → `#FF6AA5`): borders, ticks, focus rings, active-state outlines, and the single filled slider segment. No button is ever a solid pink block.
- Aperture logo mark, editorial uppercase eyebrow labels, JetBrains Mono numerics. Panels 16px radius, buttons 10px. Focus rings 1.5px pink. `prefers-reduced-motion` respected.
- macOS: frameless with the traffic lights inset onto the top bar (a window drag region); Windows keeps the native frame until Phase 8.

## Manual test scenarios — Phase 4

Edit a photo, then in the **Presets** section (Develop panel / Simple mode):

1. **Save a look**: adjust some sliders → **+ Save current** → name it. It appears as a tile showing the current photo with the preset applied.
2. **Live thumbnails**: each preset tile renders the *current* photo through that preset (via the shared shader), so different presets look visibly different — and update when you switch photos.
3. **Apply**: click a tile → its adjustments merge onto the current edit (your crop/rotate/flip are preserved). Autosaves to the sidecar like any edit.
4. **Delete**: hover a tile → ✕.
5. **Persistence**: presets are JSON in the app's userData; they survive restarts.
6. **Import Lightroom `.xmp`**: **Import .xmp** → pick a preset file. A summary shows the **mapped** fields and any **not supported** (`Dehaze`, `Texture`, split toning, lens corrections, …) plus an *"approximate mapping — results may differ slightly from Adobe's rendering"* notice. Choose **Apply now** or keep it as a preset.
7. **Local-only**: `.xmp` is read locally; nothing leaves the device; `connect-src 'none'` intact.

## Manual test scenarios — Phase 3

Edit a photo, then click **Export** (top bar):

1. **Formats**: choose JPEG (with Quality), PNG, or TIFF. Set Resize to Original / 2048 / 4096. The output is rendered at full resolution through the **same shader** as the preview, so exported pixels match what you see.
2. **Filename pattern**: e.g. `{name}_{seq}` → `IMG_2040_001.jpg`. Tokens: `{name} {seq} {date} {W} {H}`. Existing files are never overwritten (auto `-1`, `-2`).
3. **Metadata → Keep**: exported file retains the original's EXIF/GPS/XMP (verify with `exiftool out.jpg`).
4. **Metadata → Strip**: exported file has no EXIF/GPS/XMP.
5. **Metadata → Frame**: EXIF is stripped from the file *and* the shooting info (camera · focal · aperture · shutter · ISO · date) is burned onto a typographic border — pick **Minimal White** or **Black Film**; the dialog shows a live preview.
6. **Batch**: with a filter active and >1 photo, choose **All N** to export the whole set; each non-selected photo uses its own sidecar edits.
7. **Local-only**: files are written only to the folder you pick; `connect-src 'none'` intact; nothing leaves the device.

## Manual test scenarios — Phase 2

Run `npm run dev`, open a folder, select a photo, then:

1. **Real-time develop**: in Expert mode, drag any Light/Color slider — the canvas updates instantly (WebGL). Exposure brightens, contrast adds punch, temperature warms/cools, saturation/vibrance shift colour.
2. **Tone curve**: expand *Tone Curve*, drag a point (or click the line to add one) — an S-curve adds contrast live. Switch R/G/B channels for split-toning. `reset` restores the identity line.
3. **Color Mixer (HSL)**: expand *Color Mixer*, pick a colour band, adjust Hue/Saturation/Luminance — only that hue range changes (e.g. deepen just the blues).
4. **Detail / Effects / Geometry**: Clarity + Sharpening add local contrast; Vignette darkens/brightens corners; Straighten rotates, Flip H/V mirror.
5. **Before/after**: hold `Space` for full original; click **⊟ Compare** (or `\`) for a **draggable split** — drag the divider to wipe between original (left) and edited (right).
6. **Auto Enhance** (Simple mode): one click sets tone from the image histogram (black/white points, median) + denoise from ISO.
7. **Non-destructive persistence**: edits autosave to `<photo>.lux.json` next to the original. Reselect the photo (or restart the app) — edits reload. The **◆ badge** marks edited thumbnails. The original file is never modified.
8. **Local-only**: `connect-src 'none'` intact; all editing is in-process WebGL, nothing leaves the device.

## Manual test scenarios — Phase 1

Run `npm run dev`, then:

1. **Open Folder** (left drawer) → native picker. Pick a folder of photos (RAW and/or JPEG/PNG/TIFF/HEIF, including subfolders). The scan is recursive; thumbnails stream into the grid + filmstrip as they decode.
2. **Select a photo** → its 2560px proxy renders on the canvas (a "decoding…" spinner shows briefly first). The bottom toolbar shows filename, dimensions, camera/ISO (RAW).
3. **RAW files** show a `RAW` badge and decode via LibRaw (embedded preview for thumbnails, demosaiced proxy for the canvas).
4. **Ratings**: on the selected photo, click the stars (or press `1`–`5`, `0` to clear). **Flag**: click ⚑ or press `P`. Both persist.
5. **Filter** (left drawer): type to filter by filename, pick an extension, set a minimum star rating, or toggle flagged-only. The grid and filmstrip update; the count shows "N of total".
6. **Navigation**: `←`/`→` move through the filtered set. `Space` shows the before/after badge (real comparison arrives in Phase 2).
7. **Cache persistence**: reopen the same folder — thumbnails appear instantly from the SQLite+webp cache (stored under the app's userData dir). Editing a file's contents (new mtime) re-decodes it.
8. **Local-only check**: DevTools → Network shows no outbound requests; `connect-src 'none'` is in `index.html`. Pixels, paths, and EXIF never leave the device.

> **RAW note:** RAW decode (LibRaw demosaic in the hidden decode window) is verified end-to-end across all 11 tested manufacturers/formats. Very new cameras beyond this LibRaw build (e.g. Sony A9 III uncompressed) fall back to the embedded JPEG preview so the photo still displays. JPEG/PNG/TIFF/webp decode + proxy + cache are also verified end-to-end.

## Manual test scenarios — Phase 0

Run `npm run dev`, then verify:

1. **App launches** to the welcome state: near-black stage, "Welcome to Luxinus", left drawer + right edit panel as floating glass.
2. **Open Folder** (left drawer) opens the native OS folder picker. Picking a folder populates the thumbnail grid, filmstrip, and selects the first photo. *(Phase 0 seeds placeholder items; Phase 1 does the real scan.)*
3. **Mode toggle** (top bar) switches the right panel between Simple (Auto Enhance + 4 large sliders) and Expert (Light/Color/Detail sections).
4. **Sliders** drag smoothly; only the filled segment shows the pink gradient; the numeric value updates in mono; Reset returns them to 0.
5. **Before/after**: hold `Space` → a "Before" badge appears; release → it clears.
6. **Drawer collapse**: the `‹` button collapses the left drawer to a rail; clicking the rail expands it.
7. **Local-only check**: open DevTools console — no outbound network requests; CSP violations (if any external request were attempted) would be reported. `connect-src 'none'` is present in `index.html`.

## Dependency justifications

Per project rule, every dependency is justified:

- **sharp** — libvips-backed decode/resize/encode for JPEG/PNG/TIFF/HEIF and all proxy/thumbnail generation (webp). N-API, ABI-stable.
- **libraw-wasm** — LibRaw compiled to WASM; RAW decode (demosaiced RGB, embedded preview, and pre-demosaic Bayer access for the Phase 5 RAW-denoise hook) in the hidden Chromium decode window, no native compilation. Verified across Canon CR2/CR3, Nikon NEF, Sony ARW (compressed/uncompressed/lossless), Fuji RAF, Olympus ORF, Panasonic RW2, Pentax PEF, and Adobe DNG.
- **better-sqlite3** — synchronous, fast SQLite for the thumbnail/metadata cache (rating/flag persistence). Rebuilt for Electron's ABI via electron-builder.
- **@types/better-sqlite3** *(dev)* — types for the above.
- **exiftool-vendored** *(Phase 3)* — reads/writes EXIF/GPS/XMP for the export metadata policy (Keep copies tags from the original; Strip/Frame remove all). Ships a vendored ExifTool+Perl, unpacked from the asar at build.
- **fast-xml-parser** *(Phase 4)* — parses Lightroom `.xmp` presets to map the `crs:` namespace onto Luxinus parameters. Pure-JS, no native deps.

## Roadmap

Phase 0 ✓ scaffold · **1 ✓ library + RAW proxy** · **2 ✓ basic editing + sidecars** · **3 ✓ export (Keep/Strip/Frame)** · **4 ✓ presets (JSON + `.xmp`)** · 5 geometry + local masks (crop/scale UI, straighten/aspect, brush & radial/linear masks) · 6 ONNX infra + AI denoise · 7 upscale (HAT → SUPIR) · 8 AI masking/remove (SAM2 + LaMa) · 9 onboarding + polish + packaging.

See [`ROADMAP.md`](./ROADMAP.md) for the phase plan in detail. **Phase 5 is now the non-AI geometry & local-adjustment layer** (interactive crop, photo scaling/straighten, and manually-drawn masks); the AI inference stack (ONNX runtime + denoise) moved to **Phase 6**.

### Editing architecture (Phase 2)

Edits render through a **WebGL fragment shader** (`EditCanvas`) applied to the decoded proxy texture — the full stack (white balance → exposure → tone regions → contrast → tone-curve LUT → HSL mixer → vibrance/saturation → clarity/sharpen → vignette) runs in one pass at frame rate. The **same math** drives export at full resolution (Phase 3). The tone curve is a CPU-built 256×1 LUT (monotone cubic); the develop state is a versioned object persisted to a sidecar `<file>.lux.json` via an atomic temp-write+rename, so a crash never corrupts it and originals are never opened for writing.

### Export architecture (Phase 3)

Export re-runs the **same shader module** (`lib/editShader.ts`) at full resolution inside the hidden Chromium window — RAW is decoded full-size by LibRaw there, standard formats via the browser's own decoders (TIFF/HEIF pre-converted by sharp). Frame mode composites the border + typographic caption on a 2D canvas using the **bundled fonts** (Bricolage for the camera line, Geist Mono for the technical line), so the burned-in text renders identically offline. The final RGBA returns to main, where **sharp** encodes JPEG/PNG/TIFF and **exiftool-vendored** applies the metadata policy (Keep copies tags from the original; Strip/Frame remove all). Because pixels are freshly encoded and metadata is copied explicitly, nothing from the original file leaks unless you choose Keep.

### Presets (Phase 4)

Native presets store the tonal/colour/curve/HSL/detail/effects state (never geometry, which is photo-specific) as JSON in `userData/presets/`; applying a preset merges it onto the current edit while preserving the photo's crop/rotate/flip. Preset thumbnails are rendered through a **single shared offscreen WebGL context** (`lib/presetThumb.ts`, reusing the edit shader) — the current photo is uploaded once and each preset draws to a cached data-URL, so a panel of N presets never spawns N GL contexts. Lightroom `.xmp` import maps the `crs:` namespace approximately (e.g. `Exposure2012` EV → exposure, `ToneCurvePV2012` 0-255 points → 0-1, `HueAdjustment*`/`SaturationAdjustment*`/`LuminanceAdjustment*` → the 8 HSL bands) and reports every field it couldn't map.
