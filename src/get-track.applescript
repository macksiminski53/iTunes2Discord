-- get-track.applescript
-- macOS equivalent of get-track.ps1. Queries the running Music app (modern
-- macOS) or legacy iTunes (pre-Catalina) for the current track and prints a
-- simple delimited line that main.js parses.
--
-- We deliberately do NOT build JSON here: track/artist names can contain
-- quotes and other characters that are painful to escape correctly in
-- AppleScript string concatenation, so we use a delimiter that's extremely
-- unlikely to appear in metadata and let Node.js do the real parsing.
--
-- IMPORTANT: "tell application <name> to ..." launches the app if it isn't
-- already running. So just like the Windows COM script, we first check the
-- process list with a plain shell `pgrep` (no Apple Events involved, so it
-- doesn't trigger any macOS automation permission prompt) and bail out
-- before ever sending the app an Apple Event if it's not already open.

set targetApp to ""

try
	do shell script "pgrep -x Music"
	set targetApp to "Music"
end try

if targetApp is "" then
	try
		do shell script "pgrep -x iTunes"
		set targetApp to "iTunes"
	end try
end if

if targetApp is "" then
	return "not_running"
end if

-- The first time this actually sends an Apple Event to Music/iTunes, macOS
-- will show a one-time permission prompt ("iTunes2Discord wants access to
-- control Music"). If the user denies it, this whole tell block throws and
-- we fall through to "not_running" below rather than crashing.
try
	tell application targetApp
		set playerState to (player state as string)

		if playerState is "stopped" then
			return "stopped"
		end if

		set trackName to ""
		set trackArtist to ""
		set trackAlbum to ""
		set trackDuration to 0
		set trackPosition to 0

		try
			set trackName to name of current track
			set trackArtist to artist of current track
			set trackAlbum to album of current track
			set trackDuration to duration of current track
			set trackPosition to player position
		on error
			return "stopped"
		end try

		set stateStr to "playing"
		if playerState is "paused" then set stateStr to "paused"

		set AppleScript's text item delimiters to "<|>"
		set outputLine to {stateStr, trackName, trackArtist, trackAlbum, (trackDuration as string), (trackPosition as string)} as string
		set AppleScript's text item delimiters to ""
		return outputLine
	end tell
on error errMsg
	return "not_running"
end try
