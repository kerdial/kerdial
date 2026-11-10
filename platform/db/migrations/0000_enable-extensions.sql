-- Custom SQL migration file, put your code below! --
-- `citext` backs `app_user.email` so a login lookup
-- does not depend on the caller's casing. Must run before any migration
-- that declares a `citext` column.
CREATE EXTENSION IF NOT EXISTS citext;
