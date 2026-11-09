import { expect, test } from "bun:test";
import { parseHash, toHash } from "./router";

test("parseHash defaults to agents", () => {
  for (const h of ["", "#", "#/", "#/nope", "#nope", "#/Agents", "#/agents/x"]) expect(parseHash(h)).toEqual({ page: "agents", query: {} });
});
test("parseHash reads page and query", () => {
  expect(parseHash("#/scores?x=1")).toEqual({ page: "scores", query: { x: "1" } });
  expect(parseHash("#/agents?agent=a%20b")).toEqual({ page: "agents", query: { agent: "a b" } });
});
test("teams alias opens the agents page", () => {
  expect(parseHash("#/teams?team=a")).toEqual({ page: "agents", query: { team: "a" } });
});
test("toHash round trip", () => {
  for (const r of [{ page: "agents" as const, query: { agent: "a b" } }, { page: "hooks" as const, query: {} }, { page: "trails" as const, query: { q: "x&y", n: "2" } }])
    expect(parseHash(toHash(r))).toEqual(r);
  expect(toHash({ page: "agents", query: { agent: "a" } })).toBe("#/agents?agent=a");
});
