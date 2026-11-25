# Chat UI blocks

An agent's reply in the agentnet chat is markdown. To show something as UI instead of text, the agent puts JSON in a fenced code block with the language `ui`. The chat draws it as a block. Everything else in the reply stays markdown.

````markdown
The build is done.

```ui
{ "type": "card", "tone": "ok", "title": "Build passed", "body": "All **23** tests pass." }
```
````

One fence holds one block (a JSON object) or up to 12 blocks (a JSON array). A reply can hold several fences, with text between them.

## The rule for bad input

A fence that is not valid JSON, names a type this chat does not know, or misses a required field **stays as it was written and shows as a code block**. Nothing is dropped and nothing breaks, so an agent can use a block type that an older chat does not have yet. If one block of an array is not valid, the whole fence stays as code.

Text is cut at a limit (200 characters for labels and titles, 600 for cells and items, 8000 for bodies) and lists are cut at a count. `body` fields are markdown and go through the same cleaning as the rest of the chat. No block can run script.

## Blocks

| type | Use it for | Required | Optional |
|---|---|---|---|
| `card` | A callout: a result, a warning, a note | `title` or `body` | `tone`: `info` (default), `ok`, `warn`, `bad` |
| `stats` | 1 to 8 figures in a row | `items`: `[{label, value}]` | `note` per item |
| `table` | Rows and columns, up to 8 columns and 60 rows | `columns`: `[text]`, `rows`: `[[text]]` | `align`: `["left" or "right"]` per column |
| `checklist` | A list of things done and not done (read-only) | `items`: `[text]` or `[{text, done}]` | `title` |
| `choices` | A question with 1 to 8 answers the owner can pick | `options`: `[text]` or `[{label, send}]` | `prompt` |
| `section` | Detail that starts folded | `title`, `body` | `open`: `true` to start open |
| `steps` | Progress through a list of steps | `items`: `[text]` or `[{text, state}]` | `title`, `note` per item. `state`: `done`, `active`, `todo` (default), `failed` |
| `image` | A picture | `src`: the absolute path of a PNG, JPEG, GIF or WebP file on this machine. An `http` or `https` URL shows as a link only: the chat loads no picture from another site | `alt`, `caption` |
| `file` | A file the agent names: a card with its first lines; tap opens the focus view. A path alone on a line becomes one too | `path` (inside the agent's project folder, with `:40` or `:40-58` for lines) | `lines`, `note`, `content` (the first lines, when the page cannot read the file) |
| `task` | A step, job, ticket or message and where it stands | `id`, `title` | `kind`: `step` (default), `job`, `ticket`, `message`. `state`: `todo` (default), `active`, `done`, `blocked`, `wait`. `owner`, `progress` as `1/3`, `sub` (the line under the title), `note` (replaces the state word, e.g. "Blocked: no login") |
| `draft` | Something not real until it is sent: a dashed card with Send and Edit | `title`, `body` | `kind`: `message` (default), `commit`, `brief`, `post`. `to`, `actions`: up to two labels. The first sends `body` as the owner's message, the second puts it in the composer |
| `result` | A deliverable: kind tile, one line, the figure that proves it | `title` | `kind`: `commit`, `shot`, `report`, `pr`, `done` (default). `sub`, `ref` (sha, `PR #12`, `1920 by 1080`), `figures`: `[{value, label}]` (4), `path`, `tags` (4), `checks`: `[text]` or `[{text, state}]` with `state` `done` (default), `todo`, `skip`, `wait`, `foot` (a warning line), `by` (the agent's name), `image` (an absolute picture path) |
| `jira` | One or more Jira tickets: a draft, the created tickets, or the ones Jira refused | `project`, `tickets`: `[{title}]` (1 to 12) | see [jira](#jira) |

### choices

Picking an option sends its `send` text (or its `label`) to the agent **as the owner's next message**, exactly as if the owner had typed it. The buttons then lock and the picked one stays marked. They also lock when the owner answers by typing instead.

```ui
{ "type": "choices", "prompt": "Deploy now?", "options": ["Yes, deploy", { "label": "Not yet", "send": "Not yet. Wait for my review." }] }
```

### jira

A Jira ticket the agent wants to create, or has created. The chat never calls Jira: the agent does, and the card only shows it. **Create**, **Edit**, **Retry** and **Leave it out** send the owner's choice to the agent as the owner's next message, like a `choices` pick; the buttons then lock. Press a ticket to open its details in place (description, fields, linked issues); press again to close.

State comes from the tickets when you leave `state` out: any ticket with an `error` makes the card `refused`, all tickets with a `key` make it `created`, otherwise it is a `draft` (dashed, checkboxes, "not in Jira yet"). A `created` or `refused` card needs at least one `key`.

Block fields: `project` (key, `AGN`), `tickets`; optional `state`, `board`, `epic` (`{key, title}`: the draft then shows "New stories under this epic"), `note`, `backlog` (the line at the foot), `url` (https only: shows "Open the epic in Jira").

Ticket fields: `title`; optional `kind` (`bug`, `story`, `task` default, `epic`, `subtask`), `key` (`AGN-413`), `status` (`To do`), `priority` (`highest`, `high`, `medium`, `low`, `lowest`), `points`, `description` (markdown, safe), `assignee`, `labels` (6), `component`, `links`: `[{rel, key, title}]` (`rel` as `Child of`, `Relates to`), `error` (Jira's reason; makes the row red), `fix` (the retry button's label, e.g. `Add a component and retry`).

```ui
{ "type": "jira", "project": "AGN", "board": "agentnet", "epic": { "key": "AGN-400", "title": "Floating chat" },
  "tickets": [
    { "title": "Lift the card surface", "kind": "story", "priority": "medium", "points": 3, "labels": ["chat"], "description": "Cards float on three shadow levels.\n\n**Done when:** all cards share one surface.", "links": [{ "rel": "Child of", "key": "AGN-400", "title": "Floating chat" }] },
    { "title": "Plan line as a floating pill", "kind": "story", "priority": "low", "points": 1 }
  ] }
```

### Several blocks in one fence

```ui
[
  { "type": "stats", "items": [{ "label": "Tests", "value": "23", "note": "0 fail" }, { "label": "Build", "value": "2.1 s" }] },
  { "type": "steps", "title": "Release", "items": [{ "text": "Build", "state": "done" }, { "text": "Checks", "state": "active" }, "Publish"] },
  { "type": "table", "columns": ["File", "Lines"], "align": ["left", "right"], "rows": [["a.ts", "30"], ["b.ts", "9"]] },
  { "type": "checklist", "title": "Before it ships", "items": [{ "text": "Typecheck", "done": true }, "Screenshots"] },
  { "type": "section", "title": "Why", "body": "The long reason, in **markdown**." },
  { "type": "image", "src": "/home/you/project/shots/after.png", "alt": "The new screen", "caption": "After the change" }
]
```

## Live UI: your own HTML, CSS and script

When no block fits, an agent can write the UI itself. A fenced code block with the language `ui-html` holds HTML, with `<style>` and `<script>` if it needs them. The chat runs it live, inside the reply, in a sandboxed frame.

````markdown
```ui-html
<h3>Ship the release?</h3>
<p>All 23 tests pass. The build took 2.1 s.</p>
<button data-send="Yes, ship it">Ship it</button>
<button data-send="No, wait for my review">Wait</button>
```
````

A click on an element with `data-send` sends that text to the agent **as the owner's next message**, like a `choices` pick. Without a value, the element's own text is sent.

With script, call `agentnet.send(text)` from a click handler:

````markdown
```ui-html
<h3>How many workers?</h3>
<input id="n" type="range" min="1" max="8" value="3">
<p><b id="v">3</b> workers, about <b id="t">20</b> min</p>
<button id="go">Use this</button>
<script>
  const n = document.getElementById("n"), v = document.getElementById("v"), t = document.getElementById("t");
  n.oninput = () => { v.textContent = n.value; t.textContent = Math.round(60 / n.value); };
  document.getElementById("go").onclick = () => agentnet.send("Use " + n.value + " workers");
</script>
```
````

### What the frame gets

- **The chat's look.** Text, links, buttons, inputs and tables are already styled, in dark and light. For your own styles use the variables `--bg`, `--panel`, `--ink`, `--muted`, `--line`, `--accent`, `--on-accent`, `--agent`, `--ok`, `--warn`, `--bad`, `--font`, `--mono`, `--radius`. The root element has `data-theme="dark"` or `"light"`; a switch fires an `agentnet:theme` event on `window`.
- **Its own height.** The frame is as tall as its content, up to 720 px, and scrolls inside past that. Its width is the reply's.
- **One answer.** `agentnet.send(text)` or `data-send`, up to 2000 characters. After the owner has answered (here or by typing), `[data-send]` elements are disabled, `agentnet.answered` holds the answer and an `agentnet:answered` event fires.

### What the frame cannot do

- **Reach the app.** It runs with `sandbox="allow-scripts"` and no `allow-same-origin`: its origin is opaque. It has no cookies, no storage and no way to the chat's page.
- **Use the network.** Its page is served with `Content-Security-Policy: default-src 'none'`. No fetch, no socket, no remote script, style, font or image. Put everything inline; images as `data:` URLs or inline SVG.
- **Leave.** No popups, no downloads, no form posts, no navigating the page around it. A frame that loads another page is replaced by its source.
- **Send on its own.** A send counts only when the owner has just clicked or pressed a key inside that frame. The chat checks this itself, outside the frame; a script that calls `agentnet.send` on load or on a timer is ignored. If the owner used the chat a moment before the click, the chat shows the line with its own Send button first.

### When it shows as code instead

An empty fence, or one over 60 000 characters, stays a code block. So does a frame that does not start. The **Code** button on every frame shows its source.

## When to use a block

Prefer a `ui` block when one fits: it is shorter and reads the same everywhere. Write `ui-html` when the owner needs a control the blocks do not have: a slider, a form with several fields, a small chart, a preview.

Use a block when the content has a shape: a few figures, a status, a list of steps, a question with fixed answers. Keep prose as prose. A reply made only of blocks is harder to read than a sentence followed by one block.

## Where it lives

- The parser: `web/src/chatBlocks.ts` (pure, tested in `web/src/chatBlocks.test.ts`).
- The drawing: `web/src/components/ChatBlock.vue`.
- A new block type is one case in the parser, one branch in the component and one row in the table above.
- Live UI: the fence is found by the same parser; the frame is `web/src/components/ChatSandbox.vue`; the send rule, the document it writes and the bridge are `web/src/chatSandbox.ts` (pure, tested in `web/src/chatSandbox.test.ts`); the shell page and its policy are in `src/net/web.ts` (`/sandbox.html`).
