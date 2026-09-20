import assert from "node:assert/strict";
import { test } from "node:test";
import { indefiniteArticle, withArticle } from "./indefinite-article.ts";

test("the bug this was written for", () => {
  assert.equal(withArticle("intro call"), "an intro call");
});

test("consonants take a", () => {
  for (const w of ["call", "discovery call", "strategy session", "briefing"]) {
    assert.equal(indefiniteArticle(w), "a", w);
  }
});

test("vowels take an", () => {
  for (const w of ["intro call", "audit", "onboarding call", "exploratory chat"]) {
    assert.equal(indefiniteArticle(w), "an", w);
  }
});

test("silent h takes an despite the consonant", () => {
  for (const w of ["hour-long call", "honest review"]) {
    assert.equal(indefiniteArticle(w), "an", w);
  }
});

test("a yoo sound takes a despite the vowel", () => {
  for (const w of ["university briefing", "usability review", "European call"]) {
    assert.equal(indefiniteArticle(w), "a", w);
  }
});

test("case and surrounding space do not matter", () => {
  assert.equal(indefiniteArticle("  Intro Call "), "an");
  assert.equal(indefiniteArticle("Call"), "a");
});

test("empty input does not throw", () => {
  assert.equal(indefiniteArticle(""), "a");
  assert.equal(indefiniteArticle("   "), "a");
});
