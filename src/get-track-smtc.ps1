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
    [void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
    [void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

    $managerOp = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
    $manager = Await $managerOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

    if ($null -eq $manager) {
        Write-Output '{"state":"not_running"}'
        exit 0
    }

    $session = $manager.GetCurrentSession()

    if ($null -eq $session) {
        Write-Output '{"state":"not_running"}'
        exit 0
    }

    # Optional: only trust sessions that look like Apple Music, to avoid
    # accidentally reporting on some other unrelated app the system thinks
    # is "current" (e.g. a browser tab that briefly played a notification
    # sound). Comment this filter out to allow ANY SMTC source.
    $appId = $session.SourceAppUserModelId
    if ($appId -notmatch 'AppleInc\.AppleMusicWin|iTunes|AppleMusic') {
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
    # The thumbnail comes back as a stream reference, not a file -- we have
    # to open it, read it into a byte buffer via a DataReader, then write
    # those bytes out to a temp file ourselves so the rest of the app can
    # treat it exactly like the file path iTunes' COM API gives us.
    $artworkPath = ""
    try {
        $thumbRef = $props.Thumbnail
        if ($null -ne $thumbRef) {
            $streamOp = $thumbRef.OpenReadAsync()
            $stream = Await $streamOp ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])

            if ($null -ne $stream -and $stream.Size -gt 0) {
                $reader = [Windows.Storage.Streams.DataReader]::new($stream)
                $loadOp = $reader.LoadAsync([System.UInt32]$stream.Size)
                Await $loadOp ([System.UInt32]) | Out-Null

                $bytes = New-Object byte[] ([int]$stream.Size)
                $reader.ReadBytes($bytes)

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
        # Common causes: app didn't provide one, or the stream content type
        # isn't a directly-savable image format.
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

