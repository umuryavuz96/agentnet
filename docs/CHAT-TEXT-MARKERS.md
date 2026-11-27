# Chat text markers

What an agent writes in a chat reply. A marker that does not parse stays as typed. Code: `web/src/chatMarkers.ts`, styles: `web/src/components/chat/chatText.css`.

| Write | Result |
|---|---|
| `:ok[4/4 pass]` `:warn[..]` `:bad[..]` `:info[..]` | Tone chip, up to 40 characters |
| `==the build is clean==` inside a sentence | Text in the speaking agent's hue |
| `==One thing needs you.==` alone on a line | Key line with a dot (use one per reply) |
| `> [!OK] Title` then quoted lines (also `NOTE`, `WARN`, `BAD`) | Callout card; without text after the tag, the first quoted line is the title |
| `#8931`, `step 1.2`, `job 14`, `PR #12` in plain text, `` `839475a` `` in backticks | Reference chip: see below |
| `` `web/src/a.ts:47` `` | File chip |
| ```` ```ts title=web/src/a.ts:30 ```` | Code block with file header and line numbers from 30 |
| ```` ```diff ```` | Added and removed lines washed in green and red, `+` and `-` kept |

## Reference chips

The text itself needs no lookup. In an agent's chat a chip then does this:

| Chip | Hover or keyboard focus | Click, Enter or Space |
|---|---|---|
| Commit sha (7 to 10 hex) | After 300 ms (at once on keyboard focus), a card: subject, `pushed`, `local only` or `not pushed`, author, date, branches, files with added and removed lines | A pane in the chat: message, file list, Copy sha |
| `PR #12` | After 300 ms (at once on keyboard focus), a card: title, `open`, `merged`, `draft` or `closed`, failed checks, author, branch and base | The pull request in a new tab |
| `#8931` | Nothing | Opens that message's row in the trail |
| `step 1.2`, `job 14` | Nothing | Opens the agent's panel on that step or job in the Trail tab |

A `#`, `step` or `job` chip with nothing to open stays plain text. The card stays while the pointer is on it. Esc, or scrolling by hand, closes it; Esc also closes the commit pane. `step 3` without a job number means a step of the current job.

Commits and pull requests are read by `GET /v1/panel/agents/{name}/ref?kind=sha|pr&id=…` (`src/net/chatRefs.ts`, read only, cached 60 s). The agent's project folder is asked first, then the folder its terminal stands in, then every folder an agent ran in (git repositories only). The first that has it wins, and the card names that repository. A pull request needs a remote and a signed-in `gh`; its number can exist in more than one repository, so read the repository name. What cannot be read answers `available: false` with the reason, and the card shows that reason.

Code blocks longer than eight lines are cut with "Show all N lines". Copy answers "Copied" for 2 seconds.
