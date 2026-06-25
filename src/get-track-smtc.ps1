# get-track-smtc.ps1
#
# Reads now-playing info via Windows' System Media Transport Controls (SMTC)
# API -- the same system that powers the lock-screen media overlay and the
# taskbar media controls. Unlike iTunes' COM interface, this isn't specific
# to one app: it works with any media app that registers with Windows,
# which includes the Apple Music app for Windows, Spotify, browsers playing
# audio, and more. This is used as a FALLBACK source when the iTunes COM
# script finds nothing, so iTunes itself is unaffected.
#
# Output contract matches get-track.ps1 so main.js can treat both sources
# identically: {"state":...,"name":...,"artist":...,"album":...,
# "duration":...,"position":...,"artworkPath":...}

$ErrorActionPreference = "SilentlyContinue"

try {
    # ---- WinRT async bridge ----
    # WinRT async methods return IAsyncOperation<T>, which PowerShell can't
    # use directly -- this reflection-based helper converts them into a
    # regular .NET Task we can wait on synchronously. This is the standard,
    # widely-used pattern for calling awaitable WinRT APIs from PowerShell.
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]

    function Await($WinRtTask, $ResultType) {
        $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
        $netTask = $asTask.Invoke($null, @($WinRtTask))
        $netTask.Wait(-1) | Out-Null
        return $netTask.Result
    }

    # Load the WinRT types we need
    [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSession, Windows.Media.Control, ContentType = WindowsRuntime]
    [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
    [void][Windows.Storage.Streams.IRandomAccessStreamReference, Windows.Storage.Streams, ContentType = WindowsRuntime]

    $managerOp = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
    $manager = Await $managerOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

    if ($null -eq $manager) {
        Write-Output '{"state":"not_running"}'
        exit 0
    }

    $session = $null
    $allSessions = $manager.GetSessions()
    foreach ($s in $allSessions) {
        if ($s.SourceAppUserModelId -match 'AppleInc\.AppleMusicWin|iTunes|AppleMusic') {
            $session = $s
            break
        }
    }

    if ($null -eq $session) {
        Write-Output '{"state":"not_running"}'
        exit 0
    }

    $propsOp = $session.TryGetMediaPropertiesAsync()
    $props = Await $propsOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])

    $playbackInfo = $session.GetPlaybackInfo()
    $timeline = $session.GetTimelineProperties()

    # PlaybackStatus: 0=Closed 1=Opened 2=Changing 3=Stopped 4=Playing 5=Paused
    $status = $playbackInfo.PlaybackStatus
    $stateStr = "stopped"
    if ($status -eq 4) { $stateStr = "playing" }
    elseif ($status -eq 5) { $stateStr = "paused" }
    elseif ($status -eq 3 -or $status -eq 0) {
        Write-Output '{"state":"stopped"}'
        exit 0
    }

    $name = $props.Title
    $artist = $props.Artist
    $album = $props.AlbumTitle

    $position = $timeline.Position.TotalSeconds
    $startTime = $timeline.StartTime.TotalSeconds
    $endTime = $timeline.EndTime.TotalSeconds
    $duration = $endTime - $startTime
    if ($duration -lt 0) { $duration = 0 }

    # ---- Thumbnail extraction ----
    # The thumbnail comes back as an IRandomAccessStreamReference -- a WinRT
    # stream interface. PowerShell's COM adapter cannot cast the raw COM
    # object it gets back from OpenReadAsync() into any of the typed stream
    # interfaces needed to actually read bytes out of it (confirmed: this is
    # a known, structural limitation of PowerShell's WinRT projection for
    # interface-typed return values with no concrete class -- see
    # https://github.com/PowerShell/PowerShell/issues/11904 for the same
    # "Cannot convert System.__ComObject" error on an unrelated WinRT API).
    #
    # Workaround: compile a tiny piece of real C# at runtime via Add-Type.
    # C# has no trouble with this exact cast (it's only PowerShell's adapter
    # that struggles), so we hand the stream reference to compiled code and
    # let IT do the reading, then just take back a plain byte[] -- something
    # PowerShell handles natively with zero WinRT casting involved.
    $artworkPath = ""
    try {
        $thumbRef = $props.Thumbnail
        if ($null -ne $thumbRef) {
            if (-not ([System.Management.Automation.PSTypeName]'MusicToDiscord.ThumbnailReader').Type) {
                Add-Type -ReferencedAssemblies 'System.Runtime.WindowsRuntime' -TypeDefinition @"
                using System;
                using System.IO;
                using System.Threading.Tasks;
                using Windows.Storage.Streams;

                namespace MusicToDiscord
                {
                    public static class ThumbnailReader
                    {
                        // Plain C# -- the IRandomAccessStreamWithContentType
                        // cast below works fine here even though the same
                        // cast fails inside PowerShell's COM adapter.
                        public static byte[] ReadAllBytes(IRandomAccessStreamReference streamRef)
                        {
                            IRandomAccessStreamWithContentType stream =
                                streamRef.OpenReadAsync().AsTask().GetAwaiter().GetResult();

                            if (stream == null || stream.Size == 0) return null;

                            using (var netStream = stream.AsStreamForRead())
                            using (var ms = new MemoryStream())
                            {
                                netStream.CopyTo(ms);
                                return ms.ToArray();
                            }
                        }
                    }
                }
"@
            }

            $bytes = [MusicToDiscord.ThumbnailReader]::ReadAllBytes($thumbRef)

            if ($null -ne $bytes -and $bytes.Length -gt 0) {
                $tempDir = [System.IO.Path]::GetTempPath()
                $artFile = Join-Path $tempDir "itunes2discord-smtc-artwork.jpg"
                [System.IO.File]::WriteAllBytes($artFile, $bytes)

                if (Test-Path $artFile) {
                    $artworkPath = $artFile
                }
            }
        }
    } catch {
        # Thumbnail extraction failed -- not critical, continue without it.
        # Common causes: app didn't provide one, JIT-compiling the C# helper
        # failed (rare, but possible on very locked-down systems), or the
        # underlying content genuinely isn't a directly-savable image format.
    }

    $obj = [PSCustomObject]@{
        state       = $stateStr
        name        = $name
        artist      = $artist
        album       = $album
        duration    = $duration
        position    = $position
        artworkPath = $artworkPath
    }

    $obj | ConvertTo-Json -Compress
} catch {
    Write-Output '{"state":"not_running"}'
    exit 0
}

