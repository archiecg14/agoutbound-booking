-- Make the fallback_url contract enforceable.
--
-- 0006 documented "Absolute https URL" in a column comment, which is a note to whoever
-- reads the schema and no help at all to whoever sets the value. A relative or malformed
-- URL renders a broken escape link on a client's live booking page, and nothing between
-- the operator and the prospect would catch it.
--
-- NULL still means "this client has no fallback", which renders no line at all.

alter table clients drop constraint if exists clients_fallback_url_is_https;

alter table clients add constraint clients_fallback_url_is_https
  check (fallback_url is null or fallback_url ~ '^https://[^[:space:]]+$');
