/**
 * The join line every prospect-facing message uses to say where the call happens.
 *
 * One function so the calendar invitation, the "you're booked" page and the reminders
 * cannot drift into three different wordings — or, worse, one of them quietly dropping
 * the link. A client with no meeting_url gets null, and callers leave the line out.
 */
export function joinLine(meetingUrl: string | null | undefined): string | null {
  const url = meetingUrl?.trim();
  return url ? `Join the call: ${url}` : null;
}
