-- 003_functions.sql
-- All stock-affecting logic lives here so it runs atomically and cannot be
-- bypassed by the API layer. These are called via supabase.rpc(...) from
-- server/src/services/stock.js and orders.js — never directly from the browser.

-- Reserve stock for one product line inside an order. Raises if insufficient.
create or replace function reserve_stock(p_product_id text, p_qty int, p_order_id uuid, p_actor uuid)
returns void
language plpgsql
as $$
declare v_updated int;
begin
  update inventory
     set stock_reserved = stock_reserved + p_qty
   where product_id = p_product_id
     and stock_on_hand - stock_reserved >= p_qty;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'INSUFFICIENT_STOCK: %', p_product_id using errcode = 'P0001';
  end if;

  insert into stock_movements(product_id, delta, reason, order_id, actor_id)
  values (p_product_id, -p_qty, 'order_reserved', p_order_id, p_actor);
end;
$$;

-- Release a reservation (order cancelled/expired before payment).
create or replace function release_stock(p_product_id text, p_qty int, p_order_id uuid, p_actor uuid, p_reason stock_reason default 'reservation_released')
returns void
language plpgsql
as $$
begin
  update inventory
     set stock_reserved = greatest(stock_reserved - p_qty, 0)
   where product_id = p_product_id;

  insert into stock_movements(product_id, delta, reason, order_id, actor_id)
  values (p_product_id, p_qty, p_reason, p_order_id, p_actor);
end;
$$;

-- Commit stock: on payment confirmation, permanently deduct from on_hand.
create or replace function commit_stock(p_product_id text, p_qty int, p_order_id uuid, p_actor uuid)
returns void
language plpgsql
as $$
begin
  update inventory
     set stock_on_hand   = stock_on_hand - p_qty,
         stock_reserved  = stock_reserved - p_qty
   where product_id = p_product_id;

  insert into stock_movements(product_id, delta, reason, order_id, actor_id)
  values (p_product_id, -p_qty, 'order_paid', p_order_id, p_actor);
end;
$$;

-- Manual stock adjustment by staff (restock, correction, damage etc.).
create or replace function adjust_stock(p_product_id text, p_delta int, p_reason stock_reason, p_actor uuid, p_note text default null)
returns void
language plpgsql
as $$
declare v_updated int;
begin
  update inventory
     set stock_on_hand = stock_on_hand + p_delta
   where product_id = p_product_id
     and stock_on_hand + p_delta >= stock_reserved
     and stock_on_hand + p_delta >= 0;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'INVALID_ADJUSTMENT: %', p_product_id using errcode = 'P0001';
  end if;

  insert into stock_movements(product_id, delta, reason, actor_id, note)
  values (p_product_id, p_delta, p_reason, p_actor, p_note);
end;
$$;

-- Atomically create an order + its items + reserve stock for stocked items.
-- p_items: jsonb array of {product_id, quantity, unit_price, product_name, line_total}
-- Caller (Node service) has already validated product prices/types/stock availability
-- against the products table in the same request; this function re-checks stock
-- atomically so two concurrent checkouts cannot both win the last unit.
create or replace function create_order_tx(
  p_order_id uuid, p_order_number text, p_profile_id uuid, p_items jsonb,
  p_subtotal numeric, p_delivery_fee numeric, p_total numeric,
  p_delivery_method delivery_method, p_address_snapshot jsonb, p_notes text,
  p_terms_version text, p_expires_at timestamptz, p_quote_id uuid default null
) returns void
language plpgsql
as $$
declare
  item jsonb;
  v_fulfilment fulfilment_type;
begin
  insert into orders(
    id, order_number, profile_id, quote_id, status, subtotal, delivery_fee, total,
    payment_reference, delivery_method, address_snapshot, notes, terms_version, expires_at
  ) values (
    p_order_id, p_order_number, p_profile_id, p_quote_id, 'pending_payment', p_subtotal, p_delivery_fee, p_total,
    p_order_number, p_delivery_method, p_address_snapshot, p_notes, p_terms_version, p_expires_at
  );

  for item in select * from jsonb_array_elements(p_items) loop
    insert into order_items(order_id, product_id, product_name, unit_price, quantity, line_total)
    values (
      p_order_id,
      item->>'product_id',
      item->>'product_name',
      (item->>'unit_price')::numeric,
      (item->>'quantity')::int,
      (item->>'line_total')::numeric
    );

    select fulfilment_type into v_fulfilment from products where id = (item->>'product_id');
    if v_fulfilment = 'stocked' then
      perform reserve_stock((item->>'product_id')::text, (item->>'quantity')::int, p_order_id, p_profile_id);
    end if;
  end loop;
end;
$$;

-- Release stock for every stocked line in an order (used on cancel/expire/reject-to-terminal).
create or replace function release_order_stock(p_order_id uuid, p_actor uuid, p_reason stock_reason default 'reservation_released')
returns void
language plpgsql
as $$
declare item record;
begin
  for item in
    select oi.product_id, oi.quantity from order_items oi
    join products p on p.id = oi.product_id
    where oi.order_id = p_order_id and p.fulfilment_type = 'stocked'
  loop
    perform release_stock(item.product_id, item.quantity, p_order_id, p_actor, p_reason);
  end loop;
end;
$$;

-- Commit stock for every stocked line in an order (used on payment confirmation).
create or replace function commit_order_stock(p_order_id uuid, p_actor uuid)
returns void
language plpgsql
as $$
declare item record;
begin
  for item in
    select oi.product_id, oi.quantity from order_items oi
    join products p on p.id = oi.product_id
    where oi.order_id = p_order_id and p.fulfilment_type = 'stocked'
  loop
    perform commit_stock(item.product_id, item.quantity, p_order_id, p_actor);
  end loop;
end;
$$;

-- Scheduled job: expire unpaid orders past their window, releasing stock.
create or replace function expire_unpaid_orders()
returns int
language plpgsql
as $$
declare v_order record; v_count int := 0;
begin
  for v_order in
    select id from orders
    where status = 'pending_payment' and expires_at is not null and expires_at < now()
  loop
    perform release_order_stock(v_order.id, null, 'reservation_released');
    update orders set status = 'expired', updated_at = now() where id = v_order.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
