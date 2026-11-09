# Embedding the agentnet web app

The agentnet web app is a static single page app served by agentnet itself at `/`. Any host app can show it in an
iframe and keep its own navigation. This note is the contract for hosts.

## 1. Serve it from the same origin

Serve agentnet under a path prefix of your own origin, for example `/agentnet/`. Forward `<prefix>/v1/panel/*` and the
legacy panel paths (the `/api/v1/...` routes listed in `src/net/mount.ts`) to agentnet. The origin must be the same
because the app uses relative URLs and same-origin `postMessage`. The build uses `base: "./"`, so one build works at `/`
and at any prefix.

## 2. The iframe

```html
<iframe src="/agentnet/?embed=1&theme=dark#/agents"></iframe>
```

Query parameters:

- `embed=1` removes the top bar and the outer padding. The page fills the frame, and the host draws its own chrome.
- `theme=light|dark` fixes the colour theme. Without it the app follows `prefers-color-scheme`. Other values are ignored.

The hash is `#/<page>?<query>`. Pages: `agents`, `usage`, `scores`, `trails`, `search`, `hooks`, `routing`, `personas`.
On the Agents page the query key `agent` opens that agent's panel. `#/teams?team=<id>` is an alias that opens the
team panel on the Agents page. An empty or unknown hash opens Agents.

## 3. Messages from the frame

When the route changes in embed mode, the frame posts this to `window.parent`:

```js
{ type: "agentnet:route", hash: "#/teams?team=x" }
```

The target origin is the origin of the page, never `*`. Check `event.origin` and `event.source` in the host before you
trust a message. The host may set `iframe.contentWindow.location.hash` to navigate the app. The app follows it through
`hashchange` and does not post that hash back, so there is no loop.

## 4. Writes need root

Reads work for every caller that can reach the prefix. Writes (config pages, panel actions such as Hooks, Routing,
Personas roles, teams) need the root caller. The host must forward them from loopback without proxy headers
(`X-Forwarded-For` and similar), or with the root token. A request that carries a proxy header is treated as remote and
gets `403`. Drop `Authorization`, cookies and proxy headers on the trusted forward, as the Server OS proxy does.

## 5. Security headers

The static route sends a CSP and `X-Frame-Options: SAMEORIGIN`. Only a same-origin host can frame the app.
