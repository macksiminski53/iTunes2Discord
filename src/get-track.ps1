# get-track.ps1
# Queries the running iTunes app via COM and prints current track info as JSON.
# Exit behavior: prints {"state":"not_running"} if iTunes isn't running, or
# {"state":"stopped"} if it's running but nothing is loaded/playing.

$ErrorActionPreference = "SilentlyContinue"

# IMPORTANT: "New-Object -ComObject iTunes.Application" will silently LAUNCH
# iTunes if it isn't already running (COM auto-activation). Since this script
# runs on a timer, that would relaunch iTunes in the background every poll.
# So we first check the process list and bail out without ever touching COM
# if iTunes isn't actually open.
$proc = Get-Process -Name "iTunes" -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Output '{"state":"not_running"}'
    exit 0
}

try {
    $itunes = New-Object -ComObject iTunes.Application
} catch {
    Write-Output '{"state":"not_running"}'
    exit 0
}

if ($null -eq $itunes) {
    Write-Output '{"state":"not_running"}'
    exit 0
}

$playerState = $itunes.PlayerState  # 0 = stopped, 1 = playing, 2 = paused (fast fwd/rewind also exist)

if ($playerState -eq 0) {
    Write-Output '{"state":"stopped"}'
    exit 0
}

$track = $itunes.CurrentTrack

if ($null -eq $track) {
    Write-Output '{"state":"stopped"}'
    exit 0
}

$name = $track.Name
$artist = $track.Artist
$album = $track.Album
$duration = $track.Duration          # total length in seconds
$position = $itunes.PlayerPosition   # current position in seconds

$stateStr = "playing"
if ($playerState -eq 2) { $stateStr = "paused" }

# Try to extract album artwork and save it to a temp file
$artworkPath = ""
try {
    $artCollection = $track.Artwork
    if ($artCollection.Count -gt 0) {
        $art = $artCollection.Item(1)
        $tempDir = [System.IO.Path]::GetTempPath()
        $artFile = Join-Path $tempDir "itunes2discord-artwork.jpg"
        $art.SaveArtworkToFile($artFile)
        if (Test-Path $artFile) {
            $artworkPath = $artFile
        }
    }
} catch {
    # Artwork extraction failed — not critical, continue without it
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
