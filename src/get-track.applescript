-- MusicToDiscord track reader for macOS Apple Music
-- Outputs pipe-delimited: state|name|artist|album|duration|position
-- or "not_running" if Music is not running or nothing is playing.

set delim to "|MTOD|"

try
    if application "Music" is not running then
        return "not_running"
    end if
    
    tell application "Music"
        set ps to player state
        
        if ps is stopped then
            return "stopped"
        end if
        
        if ps is playing then
            set stateStr to "playing"
        else if ps is paused then
            set stateStr to "paused"
        else
            return "stopped"
        end if
        
        set t to current track
        set trackName to name of t
        set trackArtist to artist of t
        set trackAlbum to album of t
        set trackDuration to (duration of t) as string
        set trackPosition to (player position) as string
        
        return stateStr & delim & trackName & delim & trackArtist & delim & trackAlbum & delim & trackDuration & delim & trackPosition
    end tell
on error errMsg
    return "not_running"
end try
