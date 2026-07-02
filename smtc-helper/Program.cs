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
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Windows.Media.Control;
using Windows.Storage.Streams;
// "Encoder" is ambiguous between System.Drawing.Imaging.Encoder and
// System.Text.Encoder (the latter pulled in transitively) -- this alias
// pins it to the one we actually mean, used in SaveAsCompressedJpeg below.
using DrawingEncoder = System.Drawing.Imaging.Encoder;

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

            // Originally this only matched Apple Music/iTunes by app ID, since
            // that's the gap we built this for (no public automation API).
            // But SMTC is a general Windows media-session system -- Spotify,
            // browsers playing YouTube Music/SoundCloud/etc, Windows Media
            // Player, and most modern media apps all register with it the
            // same way, with zero extra code needed on our end. So we now
            // accept any session Windows reports, rather than filtering by
            // app ID at all.
            //
            // With that widened, a real question comes up: what if more than
            // one app has an active session at once (e.g. Spotify playing in
            // the background while a YouTube tab sits paused)? We prefer
            // whichever session is actually PLAYING; a paused/stopped one is
            // only used as a last resort if nothing else is playing. Without
            // this, we'd just take whatever Windows happens to list first,
            // which could easily show a paused tab's stale info instead of
            // the song that's actually audible right now.
            GlobalSystemMediaTransportControlsSession session = null;
            GlobalSystemMediaTransportControlsSession fallbackSession = null;
            foreach (var s in manager.GetSessions())
            {
                var info = s.GetPlaybackInfo();
                if (info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
                {
                    session = s;
                    break;
                }
                if (fallbackSession == null &&
                    info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused)
                {
                    fallbackSession = s;
                }
            }
            if (session == null) session = fallbackSession;

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
                // Filenames are now unique per run (see below), so nothing
                // else deletes old ones -- sweep leftovers from previous
                // invocations here so temp doesn't slowly fill up with
                // stale album art over a long session.
                foreach (var oldFile in Directory.GetFiles(Path.GetTempPath(), "itunes2discord-smtc-artwork-*.jpg"))
                {
                    try { File.Delete(oldFile); } catch { /* still in use or already gone -- fine, next run will catch it */ }
                }
            }
            catch { /* temp dir enumeration failed -- not worth failing the whole run over */ }

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
                                    // Different SMTC apps hand back thumbnails in
                                    // different formats and sizes -- confirmed
                                    // directly: Apple Music gives a small real
                                    // JPEG, but Windows Media Player gives an
                                    // uncompressed BMP (~1.6MB for a 648x646
                                    // image). Two separate problems followed
                                    // from that: a BMP mislabeled as ".jpg" gets
                                    // correctly rejected by Imgur, and even with
                                    // the right extension, base64-encoding a
                                    // ~1.6MB file (~2.1MB encoded) likely exceeds
                                    // Imgur's anonymous-upload size limit --
                                    // which fails at the infrastructure level
                                    // (an S3-style XML error) rather than
                                    // Imgur's own API, since the request never
                                    // gets that far. Decoding and re-encoding as
                                    // a compressed JPEG fixes both at once:
                                    // correct format, and file size in the same
                                    // small ballpark Apple Music's JPEGs were
                                    // already working fine.
                                    var tempDir = Path.GetTempPath();
                                    var artFile = Path.Combine(tempDir, $"itunes2discord-smtc-artwork-{Guid.NewGuid():N}.jpg");
                                    SaveAsCompressedJpeg(bytes, artFile);
                                    artworkPath = artFile;
                                }
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                // Thumbnail extraction failed -- not critical, continue
                // without it. Common causes: app didn't provide one, or the
                // underlying content isn't a directly-savable image format.
                // Logged to stderr (not stdout, so it doesn't corrupt the
                // JSON contract) -- main.js's smtc-helper stderr handler
                // surfaces this in the app log so failures are actually
                // diagnosable instead of silently vanishing.
                Console.Error.WriteLine($"Thumbnail extraction failed: {ex}");
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

    // Decodes whatever image format the thumbnail came in (JPEG, BMP, PNG --
    // System.Drawing's Image.FromStream auto-detects this, no need to guess)
    // and re-encodes it as a JPEG at moderate quality. This guarantees two
    // things every time, regardless of source app: the file Imgur receives
    // is always a real, valid JPEG (never a mislabeled BMP/PNG), and it's
    // always reasonably small (typically tens of KB, not the ~1.6MB an
    // uncompressed BMP thumbnail came in at) -- both were real causes of
    // upload failures we hit with Windows Media Player specifically.
    private static void SaveAsCompressedJpeg(byte[] sourceBytes, string outputPath)
    {
        using (var inputStream = new MemoryStream(sourceBytes))
        using (var image = Image.FromStream(inputStream))
        {
            var jpegCodec = ImageCodecInfo
                .GetImageDecoders()
                .First(c => c.FormatID == ImageFormat.Jpeg.Guid);

            var encoderParams = new EncoderParameters(1);
            encoderParams.Param[0] = new EncoderParameter(DrawingEncoder.Quality, 85L);

            image.Save(outputPath, jpegCodec, encoderParams);
        }
    }
}
