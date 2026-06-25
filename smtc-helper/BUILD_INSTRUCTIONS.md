# Building smtc-helper.exe

This is a small, separate C# project that replaces `get-track-smtc.ps1`'s
broken album-art extraction. Track name/artist/position will also be read
through this instead of the old script, so it fully replaces it.

## Why this exists instead of staying in PowerShell

Short version: PowerShell genuinely cannot read the thumbnail bytes for an
SMTC session, two different ways, for two different structural reasons.
A real compiled C# project has neither problem. See the long comment at the
top of `Program.cs` if you want the full story.

## One-time setup: install the .NET SDK (skip if you already have it)

1. Go to https://dotnet.microsoft.com/download
2. Download the **.NET 8.0 SDK** (not just the Runtime) for Windows x64
3. Run the installer, click through with defaults

Check it worked by opening a fresh cmd window and running:
```
dotnet --version
```
You should see something like `8.0.xxx`.

## Building the helper

1. Put the `smtc-helper` folder (containing `Program.cs` and
   `smtc-helper.csproj`) anywhere on your PC -- it does NOT need to be
   inside your main `itunes2discord` project folder, though you can put it
   there too (e.g. as a `smtc-helper/` subfolder) if you'd like everything
   in one place for git.

2. Open cmd inside that `smtc-helper` folder (same trick as always: click
   the address bar, type `cmd`, hit Enter).

3. Run:
   ```
   dotnet publish -c Release -o publish
   ```
   (The self-contained / single-file / win-x64 settings are now baked into
   `smtc-helper.csproj` itself, so this simpler command does the same
   thing as the longer one from before -- and importantly, this build
   bundles the .NET runtime directly into the .exe, so it'll work on any
   Windows PC regardless of what .NET version -- if any -- is installed
   there. That matters once this ships to other users, not just your PC.)

4. This creates a `publish` folder. Inside it, you want **`smtc-helper.exe`**
   specifically (there may be a couple of other small files too -- that's
   normal for a framework-dependent build).

## Testing it standalone (do this before wiring it into the app)

With Apple Music open and playing a song that has cover art:

```
publish\smtc-helper.exe
```

You should see one line of JSON printed, e.g.:
```
{"state":"playing","name":"My Hood","artist":"Kanye West","album":"Bully","duration":156,"position":12,"artworkPath":"C:\\Users\\Markus\\AppData\\Local\\Temp\\itunes2discord-smtc-artwork.jpg"}
```

The important part: **`artworkPath` should now be a real file path, not
`""`**. If you check that path in File Explorer, it should actually be a
valid jpg of the album cover.

If it still comes back empty or errors, paste exactly what it prints and
we'll dig in further -- but this approach sidesteps both issues we hit in
PowerShell, so it has a much better chance of actually working.

## Next step

Once you've confirmed `artworkPath` comes back populated, let me know and
I'll give you the updated `main.js` + `package.json` changes to wire
`smtc-helper.exe` into the real app (replacing the call to
`get-track-smtc.ps1`) and to ship the compiled `.exe` properly inside the
installer.
