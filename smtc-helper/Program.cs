// smtc-helper.cs
//
// Standalone console app that reads now-playing info from Windows' System
// Media Transport Controls (SMTC) -- the same system that powers the
// lock-screen media overlay. This covers the Apple Music app for Windows
// (which has no public automation API of its own), Spotify, browsers, etc.
//
// WHY THIS EXISTS AS A COMPILED .EXE INSTEAD OF A POWERSHELL SCRIPT:
// We originally tried this in pure PowerShell. Reading track name/artist/
// position works fine there. But extracting the album art thumbnail does
// not: the thumbnail comes back as an IRandomAccessStreamReference (a WinRT
// stream interface), and PowerShell's COM adapter cannot cast the raw COM
// object it gets back into any of the typed interfaces needed to actually
// read bytes from it -- this is a known, structural limitation of
// PowerShell's WinRT projection for interface-typed return values with no
// concrete class (see https://github.com/PowerShell/PowerShell/issues/11904
// for the same "Cannot convert System.__ComObject" error on an unrelated
// WinRT API). We then tried compiling a C# helper at runtime from inside
// the PowerShell script via Add-Type -- that hits a SEPARATE wall: Add-Type
// uses the legacy CodeDom compiler, which cannot reference a raw .winmd
// file at all (FileLoadException, HRESULT 0x80131047 -- .winmd is metadata,
// not a loadable .NET assembly the classic loader understands).
//
// A real, separately-compiled C# project has neither problem: a modern
// build (dotnet build / csc against the right SDK) resolves
// Windows.Storage.Streams natively, and the resulting .exe has no
// PowerShell involved at any point. So this thumbnail extraction only works
// as an actual compiled binary, not a script -- hence shipping it as
// smtc-helper.exe alongside the PowerShell scripts, called the same way
// (spawn, read stdout, parse JSON).
//
// Output contract matches get-track.ps1 / get-track-smtc.ps1 so main.js can
// treat all three sources identically:
// {"state":...,"name":...,"artist":...,"album":...,"duration":...,
//  "position":...,"artworkPath":...}

using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Windows.Media.Control;
using Windows.Storage.Streams;

internal static class Program
{
    private static async Task<int> Main()
    {
        try
        {
            var manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
            if (manager == null)
            {
                WriteState("not_running");
                return 0;
            }

            GlobalSystemMediaTransportControlsSession session = null;
            foreach (var s in manager.GetSessions())
            {
                var appId = s.SourceAppUserModelId ?? string.Empty;
                if (appId.IndexOf("AppleInc.AppleMusicWin", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    appId.IndexOf("iTunes", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    appId.IndexOf("AppleMusic", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    session = s;
                    break;
                }
            }

            if (session == null)
            {
                WriteState("not_running");
                return 0;
            }

            var props = await session.TryGetMediaPropertiesAsync();
            var playbackInfo = session.GetPlaybackInfo();
            var timeline = session.GetTimelineProperties();

            // PlaybackStatus: 0=Closed 1=Opened 2=Changing 3=Stopped 4=Playing 5=Paused
            string stateStr;
            switch (playbackInfo.PlaybackStatus)
            {
                case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing:
                    stateStr = "playing";
                    break;
                case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused:
                    stateStr = "paused";
                    break;
                case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Stopped:
                case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Closed:
                    WriteState("stopped");
                    return 0;
                default:
                    WriteState("stopped");
                    return 0;
            }

            double position = timeline.Position.TotalSeconds;
            double startTime = timeline.StartTime.TotalSeconds;
            double endTime = timeline.EndTime.TotalSeconds;
            double duration = endTime - startTime;
            if (duration < 0) duration = 0;

            string artworkPath = "";
            try
            {
                var thumbRef = props.Thumbnail;
                if (thumbRef != null)
                {
                    using (var stream = await thumbRef.OpenReadAsync())
                    {
                        if (stream != null && stream.Size > 0)
                        {
                            using (var netStream = stream.AsStreamForRead())
                            using (var ms = new MemoryStream())
                            {
                                await netStream.CopyToAsync(ms);
                                var bytes = ms.ToArray();
                                if (bytes.Length > 0)
                                {
                                    var tempDir = Path.GetTempPath();
                                    var artFile = Path.Combine(tempDir, "itunes2discord-smtc-artwork.jpg");
                                    File.WriteAllBytes(artFile, bytes);
                                    artworkPath = artFile;
                                }
                            }
                        }
                    }
                }
            }
            catch
            {
                // Thumbnail extraction failed -- not critical, continue
                // without it. Common causes: app didn't provide one, or the
                // underlying content isn't a directly-savable image format.
            }

            var result = new
            {
                state = stateStr,
                name = props.Title ?? "",
                artist = props.Artist ?? "",
                album = props.AlbumTitle ?? "",
                duration = duration,
                position = position,
                artworkPath = artworkPath,
            };

            Console.WriteLine(JsonSerializer.Serialize(result));
            return 0;
        }
        catch
        {
            // Anything unexpected (no SMTC sessions available at all, a
            // WinRT call throwing, etc.) -- fail soft so main.js's fallback
            // chain treats this the same as "nothing playing" rather than
            // crashing the poll loop.
            WriteState("not_running");
            return 0;
        }
    }

    private static void WriteState(string state)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { state }));
    }
}
