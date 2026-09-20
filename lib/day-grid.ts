/**
 * Choosing which day of a slot grid is showing.
 *
 * Pulled out of the two booking flows because the index-vs-key bug that lived here for
 * three days was invisible in a component: the repo has no component tests, so nothing
 * exercised "rebuild the day list under a selection that is already made". As a pure
 * function it is a few lines and a handful of cases.
 */

/** A day of the grid: its local-date key, and the slots falling on it. */
export type DayGroup<S> = [string, S[]];

/**
 * The index of the day to show.
 *
 * The list is rebuilt whenever the viewer changes timezone, because the grouping is done
 * in THEIR local dates — a London host's Friday afternoon is a Tokyo prospect's Saturday
 * morning, so the number of days and their order both move. A stored index does not
 * survive that: it either lands on a different day than the one tapped, or past the end,
 * where the grid renders empty with nothing selected and no explanation.
 *
 * A key survives it or it does not. "Does not" means the day the viewer picked no longer
 * exists in their new timezone, and the only sensible answer is the first day on offer —
 * never nothing.
 */
export function resolveActiveDay<S>(days: DayGroup<S>[], activeKey: string | null): number {
  if (days.length === 0) return 0;
  const i = days.findIndex(([key]) => key === activeKey);
  return i === -1 ? 0 : i;
}
