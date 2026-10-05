-- 004_rls.sql
-- Row Level Security. The Express server talks to Postgres using the Supabase
-- SERVICE ROLE key (which bypasses RLS) — RLS here is defence-in-depth in case
-- a key ever leaks or a future client-side Supabase call is added by mistake.
-- No policies are granted to 'anon' — the browser has no direct DB access at all.

alter table profiles enable row level security;
alter table addresses enable row level security;
alter table categories enable row level security;
alter table products enable row level security;
alter table inventory enable row level security;
alter table stock_movements enable row level security;
alter table quote_requests enable row level security;
alter table quotes enable row level security;
alter table files enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table payments enable row level security;
alter table tickets enable row level security;
alter table ticket_messages enable row level security;
alter table settings enable row level security;
alter table audit_log enable row level security;

-- Public read of active catalogue only (harmless if ever queried directly).
create policy catalogue_public_read on categories for select using (true);
create policy products_public_read on products for select using (is_active = true);

-- Authenticated users may read/update their own profile row.
create policy profile_self_read on profiles for select using (auth.uid() = id);
create policy profile_self_update on profiles for update using (auth.uid() = id);

-- Authenticated users manage their own addresses.
create policy addresses_self on addresses for all using (auth.uid() = profile_id);

-- Orders/quote_requests/tickets: owner-only by default (staff access goes
-- through the service-role-key server, which bypasses RLS entirely).
create policy orders_self on orders for select using (auth.uid() = profile_id);
create policy order_items_self on order_items for select using (
  exists (select 1 from orders o where o.id = order_items.order_id and o.profile_id = auth.uid())
);
create policy quote_requests_self on quote_requests for select using (auth.uid() = profile_id);
create policy tickets_self on tickets for select using (auth.uid() = profile_id);
create policy ticket_messages_self on ticket_messages for select using (
  exists (select 1 from tickets t where t.id = ticket_messages.ticket_id and t.profile_id = auth.uid())
  and is_internal_note = false
);

-- No policies at all on: inventory, stock_movements, payments, files, quotes,
-- settings, audit_log — these are only ever touched by the trusted server.
