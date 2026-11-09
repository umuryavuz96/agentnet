import { expect, test } from "bun:test";
import { noteHostHash, noteRoute, postRoute, readEmbed } from "./embed";

test("readEmbed", () => {
  expect(readEmbed("?embed=1&theme=light")).toEqual({ embed: true, theme: "light" });
  expect(readEmbed("")).toEqual({ embed: false, theme: null });
  expect(readEmbed("?theme=blue")).toEqual({ embed: false, theme: null });
  expect(readEmbed("?embed=true&theme=dark")).toEqual({ embed: false, theme: "dark" });
});

test("a host-set alias hash is not posted back normalized; a changed route still is", () => {
  const sent: unknown[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = { parent: { postMessage: (m: unknown, o: string) => sent.push([m, o]) } };
  g.location = { origin: "http://127.0.0.1:3096", hash: "" };
  noteRoute("");
  noteHostHash("#/teams?team=x");            // the host set the alias; the router normalizes it to #/agents?team=x
  postRoute("#/agents?team=x");
  expect(sent).toEqual([]);
  postRoute("#/usage");                       // a real in-frame navigation still reaches the host
  expect(sent).toEqual([[{ type: "agentnet:route", hash: "#/usage" }, "http://127.0.0.1:3096"]]);
  delete g.window; delete g.location;
});
