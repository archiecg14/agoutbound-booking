import assert from "node:assert/strict";
import { test } from "node:test";
import { joinLine } from "./meeting.ts";

test("a client with a meeting link gets a join line", () => {
  assert.equal(
    joinLine("https://us05web.zoom.us/j/123?pwd=abc"),
    "Join the call: https://us05web.zoom.us/j/123?pwd=abc",
  );
});

test("no link means no line, never a placeholder", () => {
  for (const v of [null, undefined, "", "   "]) assert.equal(joinLine(v), null, String(v));
});

test("stray whitespace from a pasted link is trimmed", () => {
  assert.equal(joinLine("  https://zoom.us/j/1  "), "Join the call: https://zoom.us/j/1");
});
