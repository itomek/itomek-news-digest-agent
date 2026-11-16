-- Only mounted into a fresh disposable PostgreSQL container.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
