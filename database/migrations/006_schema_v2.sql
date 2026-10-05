-- 006_schema_v2.sql
-- Additive schema hardening + the tables/columns the finished application needs.
-- Never edits earlier migrations; safe to run once on top of 001-005.

-- ---------------------------------------------------------------- timestamps
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$ declare t text; begin
  foreach t in array array['profiles','products','quote_requests','orders','tickets'] loop
    execute format('drop trigger if exists trg_touch_%1$s on %1$s', t);
    execute format('create trigger trg_touch_%1$s before update on %1$s for each row execute function touch_updated_at()', t);
  end loop;
end $$;

-- ------------------------------------------------------------------- orders
alter table orders add column if not exists idempotency_key text;
alter table orders add column if not exists delivery_status text not null default 'not_applicable';
alter table orders add column if not exists status_changed_at timestamptz not null default now();
do $$ begin
  alter table orders add constraint orders_delivery_status_chk
    check (delivery_status in ('not_applicable','pending','dispatched','delivered'));
exception when duplicate_object then null; end $$;

-- A repeated submit with the same key returns the original order instead of a duplicate.
create unique index if not exists uq_orders_idempotency on orders(profile_id, idempotency_key) where idempotency_key is not null;
-- A quote can become at most one order, enforced by the database.
create unique index if not exists uq_orders_quote on orders(quote_id) where quote_id is not null;
drop index if exists idx_orders_expires;
create index if not exists idx_orders_expires on orders(expires_at) where status in ('pending_payment','payment_rejected');
create index if not exists idx_payments_order on payments(order_id, submitted_at desc);

-- -------------------------------------------------------------- order items
-- Custom (quote) lines have no catalogue product. product_id becomes nullable for them.
alter table order_items alter column product_id drop not null;
alter table order_items add column if not exists is_custom boolean not null default false;
-- Per-line stock state makes reserve/commit/release idempotent and immune to a product
-- later changing fulfilment type.
alter table order_items add column if not exists stock_state text not null default 'none';
do $$ begin
  alter table order_items add constraint order_items_product_or_custom check (product_id is not null or is_custom);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table order_items add constraint order_items_stock_state_chk check (stock_state in ('none','reserved','committed','released'));
exception when duplicate_object then null; end $$;

create table if not exists order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  from_status order_status,
  to_status order_status not null,
  actor_id uuid references profiles(id),
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_order_history_order on order_status_history(order_id, created_at);

-- --------------------------------------------------------- stock movements
-- delta = change in AVAILABLE stock (on_hand_delta - reserved_delta). The component
-- columns and the after-snapshots make every movement unambiguous.
alter table stock_movements add column if not exists on_hand_delta int;
alter table stock_movements add column if not exists reserved_delta int;
alter table stock_movements add column if not exists on_hand_after int;
alter table stock_movements add column if not exists reserved_after int;
create index if not exists idx_stock_movements_created on stock_movements(created_at desc);

-- ---------------------------------------------------------------- products
alter table products add column if not exists image_path text; -- object path in the public product-images bucket
do $$ begin
  alter table products add constraint products_image_url_safe
    check (image_url is null or image_url ~ '^(https?://|/|images/)');
exception when duplicate_object then null; end $$;

-- Inventory row always exists for stocked products; a product cannot leave 'stocked'
-- while live orders still hold reservations on it.
create or replace function products_inventory_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.fulfilment_type = 'stocked' and new.fulfilment_type <> 'stocked' then
    if exists (select 1 from order_items where product_id = old.id and stock_state = 'reserved') then
      raise exception 'PRODUCT_HAS_RESERVATIONS: %', old.id using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_products_inventory_guard on products;
create trigger trg_products_inventory_guard before update on products for each row execute function products_inventory_guard();

create or replace function products_inventory_ensure() returns trigger language plpgsql as $$
begin
  if new.fulfilment_type = 'stocked' then
    insert into inventory(product_id) values (new.id) on conflict (product_id) do nothing;
  end if;
  return new;
end $$;
drop trigger if exists trg_products_inventory_ensure on products;
create trigger trg_products_inventory_ensure after insert or update of fulfilment_type on products for each row execute function products_inventory_ensure();

-- ------------------------------------------------------------------- quotes
-- At most one live quote per request; issuing a new one supersedes the old.
create unique index if not exists uq_one_issued_quote on quotes(quote_request_id) where status = 'issued';
alter table files add column if not exists quote_request_id uuid references quote_requests(id);
create index if not exists idx_files_quote_request on files(quote_request_id) where quote_request_id is not null;
create index if not exists idx_quotes_status on quotes(status, valid_until);
create index if not exists idx_ticket_messages_ticket on ticket_messages(ticket_id, created_at);

-- --------------------------------------------------- new business tables
create table if not exists contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  email text not null check (char_length(email) <= 200),
  phone text,
  service text,
  message text not null check (char_length(message) between 5 and 3000),
  status text not null default 'new' check (status in ('new','handled')),
  handled_by uuid references profiles(id),
  handled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_contact_messages_status on contact_messages(status, created_at desc);

create table if not exists favourites (
  profile_id uuid not null references profiles(id) on delete cascade,
  product_id text not null references products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, product_id)
);

alter table contact_messages enable row level security;
alter table order_status_history enable row level security;
alter table favourites enable row level security;
drop policy if exists favourites_self on favourites;
create policy favourites_self on favourites for all using (auth.uid() = profile_id) with check (auth.uid() = profile_id);

-- -------------------------------------------------- privilege-escalation fix
-- The original profile_self_update policy let any signed-in user UPDATE their own
-- role / department / is_active directly through PostgREST with the public anon key.
drop policy if exists profile_self_update on profiles;
create policy profile_self_update on profiles for update using (auth.uid() = id) with check (auth.uid() = id);

create or replace function protect_profile_privileged_columns() returns trigger language plpgsql as $$
begin
  if current_user in ('anon','authenticated') then
    if new.id is distinct from old.id
       or new.role is distinct from old.role
       or new.department is distinct from old.department
       or new.is_active is distinct from old.is_active then
      raise exception 'FORBIDDEN: role, department and active status can only be changed by an administrator' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_profiles_protect on profiles;
create trigger trg_profiles_protect before update on profiles for each row execute function protect_profile_privileged_columns();

-- ------------------------------------------------------- append-only ledgers
create or replace function forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% on % is not permitted: this table is append-only', tg_op, tg_table_name using errcode = '42501';
end $$;

do $$ declare t text; begin
  foreach t in array array['audit_log','stock_movements','order_status_history'] loop
    execute format('drop trigger if exists trg_%1$s_append_only on %1$s', t);
    execute format('create trigger trg_%1$s_append_only before update or delete on %1$s for each row execute function forbid_change()', t);
    execute format('drop trigger if exists trg_%1$s_no_truncate on %1$s', t);
    execute format('create trigger trg_%1$s_no_truncate before truncate on %1$s for each statement execute function forbid_change()', t);
  end loop;
  -- Financial / historical records may change state, but are never deleted.
  foreach t in array array['orders','payments','quotes'] loop
    execute format('drop trigger if exists trg_%1$s_no_delete on %1$s', t);
    execute format('create trigger trg_%1$s_no_delete before delete on %1$s for each row execute function forbid_change()', t);
  end loop;
end $$;

-- ---------------------------------------------------------- storage buckets
-- On a real Supabase project, create the two buckets here so setup needs no manual step.
do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('private-files', 'private-files', false)
      on conflict (id) do nothing;
    insert into storage.buckets (id, name, public) values ('product-images', 'product-images', true)
      on conflict (id) do nothing;
  end if;
end $$;
