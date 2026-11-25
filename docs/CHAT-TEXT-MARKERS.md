# Chat text markers

What an agent writes in a chat reply. A marker that does not parse stays as typed. Code: `web/src/chatMarkers.ts`, styles: `web/src/components/chat/chatText.css`.

| Write | Result |
|---|---|
| `:ok[4/4 pass]` `:warn[..]` `:bad[..]` `:info[..]` | Tone chip, up to 40 characters |
| `==the build is clean==` inside a sentence | Text in the speaking agent's hue |
| `==One thing needs you.==` alone on a line | Key line with a dot (use one per reply) |
| `> [!OK] Title` then quoted lines (also `NOTE`, `WARN`, `BAD`) | Callout card; without text after the tag, the first quoted line is the title |
| `#8931`, `step 1.2`, `job 14`, `PR #12`, `` `839475a` `` | Reference chip (found in plain text; no lookup) |
| `` `web/src/a.ts:47` `` | File chip |
| ```` ```ts title=web/src/a.ts:30 ```` | Code block with file header and line numbers from 30 |
| ```` ```diff ```` | Added and removed lines washed in green and red, `+` and `-` kept |

Code blocks longer than eight lines are cut with "Show all N lines". Copy answers "Copied" for 2 seconds.
