# Building audio-viz-helper.exe

A small, separate C# project that captures whatever audio Windows is
currently outputting (system-wide, via WASAPI loopback -- not tied to any
one app) and streams real frequency band levels to stdout continuously.
This is what drives the *real* visualizer bars, replacing the old fake
CSS-only animation.

## One-time setup

Same as `smtc-helper` -- if you already have the .NET 8 SDK installed for
that one, you're set. Otherwise:

1. Go to https://dotnet.microsoft.com/download
2. Download the **.NET 8.0 SDK** (not just the Runtime) for Windows x64
3. Run the installer, click through with defaults
4. Confirm with `dotnet --version` in a fresh terminal (should print `8.0.x`)

## Building

From inside the `audio-viz-helper` folder:

```
dotnet publish -c Release -o publish
```

This produces `publish\audio-viz-helper.exe` -- a fully self-contained
single-file exe (bundles the .NET runtime + NAudio), same deal as
smtc-helper. No separate install needed on end-user machines.

## Testing standalone

Play some audio (anything -- Apple Music, a browser tab, Spotify, whatever
is currently the active Windows audio output), then run:

```
publish\audio-viz-helper.exe
```

You should see a continuous stream of JSON lines like:

```
{"bands":[0.02,0.15,0.41,0.88,...]}
{"bands":[0.03,0.19,0.35,0.91,...]}
```

roughly 30 times a second, with the numbers actually moving in response to
what's playing. If instead you see nothing, or a single error line on
stderr, check:

- Something is actively outputting audio through the *default* Windows
  playback device (loopback only captures the default device, not a
  specific app)
- No other exclusive-mode audio app is holding the device (rare, but some
  pro audio software does this)

## Wiring it into the main app

Copy the built `audio-viz-helper.exe` into `audio-viz-helper/publish/` in
your main `itunes2discord` project (same relative path pattern as
`smtc-helper/publish/smtc-helper.exe`) -- `main.js`'s
`getAudioVizHelperPath()` looks there in dev mode, and at
`process.resourcesPath/audio-viz-helper/` once packaged (wired the same
way as smtc-helper via `extraResources` in `package.json`).
