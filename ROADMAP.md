# Luxinus — Roadmap

Fully local, on-device RAW + AI photo editor. Every phase must typecheck, build,
and run before the next begins. Nothing about a photo (pixels, path, EXIF, edit
history) ever leaves the machine.

## Shipped

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Local-only Electron shell (locked CSP, `connect-src 'none'`) | ✅ |
| 1 | Library + RAW proxy pipeline (hidden decode window, 11 manufacturers, embedded-JPEG fallback) | ✅ |
| 2 | Non-destructive editing + WebGL develop shader + sidecar persistence | ✅ |
| 3 | Export — JPEG/PNG/TIFF, 3 EXIF modes (Keep/Strip/Frame), no-overwrite | ✅ |
| 4 | Presets — native JSON save/apply/delete + Lightroom `.xmp` import | ✅ |

## Phase 5 — Geometry & local masks *(non-AI)* — ✅ core complete

The manual, deterministic editing layer that needs **no** model inference. Lands
before the AI stack so the develop pipeline is feature-complete on its own.

- ✅ **Interactive crop UI** — on-image rectangle with drag handles, aspect lock
  (free / original / 1:1 / 3:2 / 2:3 / 4:5 / 16:9), rule-of-thirds grid, scrim,
  `C`/`Esc` shortcuts. Applied crop drives the display aspect; export sizes to it.
- ✅ **Straighten guide** — alignment grid overlays the image while the Straighten
  slider is dragged. (Flip H/V already present.)
- ✅ **Local-adjustment masks** — `masks: Mask[]` on `EditState`, each with its own
  adjustment subset (exposure/contrast/tone/WB/sat/clarity), composited per-pixel
  in `editShader.ts`. **Radial** + **linear** are parametric; **brush** paints into
  a channel-packed RGBA coverage texture (up to 4 brush masks) — WebGL1-safe (no
  dynamic sampler indexing). Interactive gizmos on the stage; masks persist to the
  sidecar, participate in undo/redo, and render identically on export.
  AI-assisted selection (SAM2) comes later in Phase 8 and reuses this mask path.

Remaining polish ideas (optional): mask rename, duplicate, per-mask opacity, and a
crop-time 90° rotate.

## Phase 6 — AI inference infrastructure + denoise *(was Phase 5)* — ✅ core built

The ONNX runtime layer, built to the OOM-avoidance rules (mandatory):

- ✅ **onnxruntime-node** integrated (native; rebuilt to Electron's ABI via the
  `install-app-deps` postinstall). All inference runs in a dedicated **utility
  process** (`src/workers/onnx.worker.ts`), orchestrated by `src/main/onnx.ts`.
- ✅ **Execution-provider ladder** — CoreML (mac) / DirectML (win) / CUDA (linux),
  falling back to CPU when a provider isn't in the build.
- ✅ **Tiled inference** (`src/workers/lib/tiledInference.ts`) — fixed valid tiles
  (the NAFNet export only accepts ≥384px), reflect-padded edges, raised-cosine
  blend; **validated seamless** on a real image.
- ✅ **Sequential sessions** (one alive at a time), a **tile-size OOM ladder**
  (768→512→384 rather than halving into invalid sizes), and **graceful
  degradation** (returns the original image; never crashes).
- ✅ **F3 AI denoise (NAFNet, RGB)** — model at `models/nafnet.onnx` (OpenCV Model
  Zoo, Apache; gitignored, not bundled). A "Run AI denoise" action computes a
  restored proxy behind a progress bar; the develop shader blends it in by the
  Denoise slider (real-time strength), backward-safe when absent.

Remaining Phase 6 items:
- **Export-time full-res denoise** (route the export render through the utility
  process) — preview denoise works on the proxy today; export renders without it.
- Swap the deblur checkpoint for a NAFNet-SIDD **denoise** checkpoint (identical
  I/O — drop-in) for stronger denoising; add FP16 model support (current is FP32).
- Real VRAM probing for GPU providers (CPU path uses the OOM ladder).
- **Prerequisite — high-bit-depth pipeline (deferred here, tracked):** today the
  develop pipeline runs on an **8-bit sRGB proxy** (`decoder.ts` decodes RAW at
  `outputBps:8`, WebP-encoded), so true RAW latitude / highlight recovery isn't
  available. A **16-bit / half-float linear** proxy (`outputBps:16` + no
  auto-bright, non-WebP transport, float WebGL textures, tone-mapping in the
  shader) is required to actually use the RAW's dynamic range — it lands with the
  AI work since models also want linear high-bit input.

## Later

| Phase | Scope |
| --- | --- |
| 7 | AI upscale (HAT → SUPIR) |
| 8 | AI masking + object removal (SAM2 auto-select + LaMa inpaint), reusing the Phase 5 mask path |
| 9 | Onboarding + polish + packaging (electron-builder dmg/NSIS) |

## Non-negotiables (all phases)

1. **Local-only.** No network except an optional explicit update check. CSP stays
   `default-src 'self'` / `connect-src 'none'`.
2. Heavy work runs off the UI thread (worker / utility / hidden window).
3. Non-destructive: edits live in `<file>.lux.json` (atomic temp+rename); original
   bytes/mtime never change.
4. Graceful fallback on any AI failure or OOM.
