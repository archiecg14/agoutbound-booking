/**
 * "a" or "an" for the word that follows.
 *
 * English picks the article by sound, and sound is not recoverable from spelling: it is
 * "an hour" but "a university". So this is a heuristic, not a rule engine. It covers the
 * vowel-letter case plus the two families that break it often enough to notice — silent
 * initial h, and u- words that open on a "yoo" sound.
 *
 * That is the right depth for what it is used on: event type names, which an operator
 * types and which are short noun phrases like "intro call" or "discovery session". A name
 * exotic enough to defeat this produces a visibly odd article on a page, not a silent
 * failure, and the operator can rename the event type.
 */

/** Silent initial h: the word opens on a vowel sound despite the consonant. */
const SILENT_H = /^(hour|honest|honou?r|heir)/i;

/** Opens on a "yoo" consonant sound despite the vowel letter. */
const YOO = /^(uni(?!n)|usa|use|usu|util|euro|ubiq|eul)/i;

export function indefiniteArticle(word: string): "a" | "an" {
  const w = word.trim().toLowerCase();
  if (!w) return "a";
  if (SILENT_H.test(w)) return "an";
  if (YOO.test(w)) return "a";
  return "aeiou".includes(w[0]) ? "an" : "a";
}

/** The article and the word, ready to drop into a sentence. */
export function withArticle(word: string): string {
  return `${indefiniteArticle(word)} ${word}`;
}
