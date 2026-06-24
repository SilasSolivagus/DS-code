# Fix Report: C1 + M1 (2026-06-23)

## C1: loadRawUserSettings round-trip outputStyle/theme

### Whitelist change
Added two fields to the return object of `loadRawUserSettings()` in `src/config.ts`:
- `outputStyle: raw?.outputStyle`
- `theme: raw?.theme`

Also added `outputStyle?: string` and `theme?: string` to the `Settings` interface (lines ~71-76), since the worktree's `Settings` type did not yet include these fields (the shared-checkout `src/types.ts` had them, but the worktree `src/config.ts` inline `Settings` interface did not).

### Root cause
`loadRawUserSettings()` reconstructed a whitelisted `Settings` object field-by-field. `outputStyle` and `theme` were not included. Any read-modify-write path (e.g. `useChat.ts:1115` `raw.outputStyle = name; saveRawUserSettings(raw)`) would overwrite `outputStyle` correctly, but a subsequent `/theme` command would call `loadRawUserSettings()` (getting `outputStyle: undefined`) then `saveRawUserSettings(...)`, wiping the previously-set `outputStyle`.

### New test
**Name:** `C1 round-trip: outputStyle 与 theme 经 loadRawUserSettings/saveRawUserSettings 不丢失`
**Location:** `test/config.test.ts` in `describe('raw user settings 读写', ...)`

Before fix: `loaded.outputStyle` would be `undefined` (field missing from whitelist) — test FAILs.
After fix: both fields survive load and save-reload — test PASSes.

Test writes `{ model: 'deepseek-v3', outputStyle: 'minimal', theme: 'light' }` to `settingsFile`, calls `loadRawUserSettings()`, asserts all three fields, then calls `saveRawUserSettings(loaded)` and `loadRawUserSettings()` again to assert round-trip.

---

## M1: contextBarColor hot-switch on theme

### Change
In `src/tui/components/StatusFooter.tsx`:
- Changed signature from `contextBarColor(pct: number): string` to `contextBarColor(pct: number, theme: typeof T = T): string`
- Replaced `T.err/warn/accent` with `theme.err/warn/accent` inside the function
- Updated the two call sites inside `StatusFooter` from `contextBarColor(usedPct)` to `contextBarColor(usedPct, T)`

This makes the function themeable — callers can pass a different theme object; the component uses the live `T` singleton. Future work: when `useTheme()` / `ThemeProvider` is added to the TUI, call sites can pass the live theme instead of the static `T`.

---

## Test commands + outputs

```
npx vitest run test/config.test.ts
# Test Files  1 passed (1)
# Tests  24 passed (24)

npx vitest run test/tui.statusfooter.test.tsx
# Test Files  1 passed (1)
# Tests  15 passed (15)

npx vitest run
# Test Files  135 passed (135)
# Tests  1110 passed (1110)
# Errors  1 error  <-- pre-existing EPIPE in test/hooks.test.ts (unrelated)
```

## tsc/build
```
npx tsc --noEmit  → clean (0 errors)
npm run build     → clean (tsc -p tsconfig.build.json, 0 errors)
```
