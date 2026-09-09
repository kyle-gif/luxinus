# Luxinus — neutral darkroom UI, first implementation

Base: `3c468533788332ce1706f98f990f6a670524bdde` (main).
Target: `work`. Keep `main` unchanged.

## Scope

- Separate full-width Library and Develop workspaces.
- Keep Library mounted when hidden to retain scroll position and thumbnail size.
- Reuse the existing store, selection, filtering, thumbnail decoding, RAW preview,
  masks, histogram, edit controls, undo/redo and export dialog.
- Remove decorative LiquidGlass/GlassFilters render passes from the app shell.
- Use neutral backgrounds and restrained selection accents; show whole thumbnails.
- Hide the folder browser in Develop. Keep the existing Simple/Expert switch inside
  the inspector rather than treating it as the application's main navigation.
- Provide an explicit photo-only toggle and independent dark/gray/light canvas matte.
- Preserve multi-selection and explicit batch sync with an overwrite confirmation.
- No new packages, remote fonts, network calls, models or camera-processing changes.

## Deliberately not claimed as implemented

Agent/Codex integration, model management, AI suggestion review, semantic search,
complete Korean translation, a redesigned export dialog, album management and
advanced keyboard shortcuts remain separate follow-up work. No fake AI readiness
indicator or nonfunctional AI action is presented.

## Verification

This environment cannot clone the repository or install dependencies through its
terminal. Source changes are checked with the installed TypeScript parser and CSS
parser only. This is NOT a full-project typecheck or an Electron runtime test.

Before merging, run on a machine with the project dependencies installed:

```sh
npm ci
npm run typecheck
npm run build
npm run dev
```

Manual acceptance checks:

1. Import RAW/JPEG images; check thumbnail streaming and error handling.
2. Select with click, Cmd/Ctrl-click and Shift-click; verify every filter and reset.
3. Open a photo by double-click and by the keyboard-accessible Develop button.
4. Return to Library and confirm scroll, filter and selection persistence.
5. Compare preview, crop, masks, histogram, sliders, undo/redo and export against main.
6. Test the inspector resize handle and photo-only mode at 1440x900 and 1024x768.
7. Check that changing the canvas matte never changes exported pixels.
8. Verify batch-sync confirmation, cancellation, success, partial results and errors.
9. Confirm macOS traffic lights/drag region, keyboard focus, reduced motion and
   long Unicode filenames remain usable.

Layout changes adapt legacy absolutely-positioned components through scoped host
selectors. Replace these adapters with explicit component layout props in a later
refactor after runtime verification; do not alter the RAW pipeline just to restyle UI.
