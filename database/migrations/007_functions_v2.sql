-- 007_functions_v2.sql
-- Atomic business operations. Every money/stock mutation runs as ONE database
-- transaction with row locks and an explicit state check, so double-clicks,
-- retries, a cron job and a customer racing each other cannot corrupt state.
-- Errors are raised as 'CODE' or 'CODE: detail' with errcode P0001; the Node
-- layer maps the CODE to a friendly HTTP response.
--
-- Called only by the Express server using the service-role key. EXECUTE is
-- revoked from anon/authenticated at the bottom of this file.

drop function if exists create_order_tx(uuid,text,uuid,jsonb,numeric,numeric,numeric,delivery_method,jsonb,text,text,timestamptz,uuid);

-- ------------------------------------------------------------------ helpers
create or replace function app_setting(p_key text, p_default jsonb default null)
returns jsonb language sql stable as
$$ select coalesce((select s.value from settings s where s.key = p_key), p_default) $$;

create or replace function log_audit(p_actor uuid, p_action text, p_entity text, p_entity_id text,
                                     p_before jsonb default null, p_after jsonb default null)
returns void language sql as
$$ insert into audit_log(actor_id, action, entity, entity_id, before, after)
   values (p_actor, p_action, p_entity, p_entity_id, p_before, p_after) $$;

create or replace function log_order_status(p_order uuid, p_from order_status, p_to order_status,
                                            p_actor uuid, p_note text default null)
returns void language sql as
$$ insert into order_status_history(order_id, from_status, to_status, actor_id, note)
   values (p_order, p_from, p_to, p_actor, p_note) $$;

create or replace function order_json(p_id uuid) returns jsonb language sql stable as $$
  select to_jsonb(o) || jsonb_build_object('items', coalesce(
           (select jsonb_agg(to_jsonb(i) order by i.id) from order_items i where i.order_id = o.id), '[]'::jsonb))
    from orders o where o.id = p_id
$$;

-- ------------------------------------------------------------ stock engine
-- The single place inventory changes. Locks the row, enforces the invariants
-- (on_hand >= 0, reserved >= 0, reserved <= on_hand) and writes the ledger row.
create or replace function _stock_move(p_product text, p_on_hand int, p_reserved int, p_reason stock_reason,
                                       p_order uuid, p_actor uuid, p_note text)
returns void language plpgsql as $$
declare v inventory%rowtype; n_oh int; n_rs int;
begin
  select * into v from inventory where product_id = p_product for update;
  if not found then raise exception 'NO_INVENTORY: %', p_product using errcode = 'P0001'; end if;
  n_oh := v.stock_on_hand + p_on_hand;
  n_rs := v.stock_reserved + p_reserved;
  if n_oh < 0 or n_rs < 0 or n_rs > n_oh then
    raise exception 'STOCK_INVARIANT: % (on_hand % -> %, reserved % -> %)',
      p_product, v.stock_on_hand, n_oh, v.stock_reserved, n_rs using errcode = 'P0001';
  end if;
  update inventory set stock_on_hand = n_oh, stock_reserved = n_rs where product_id = p_product;
  insert into stock_movements(product_id, delta, reason, order_id, actor_id, note,
                              on_hand_delta, reserved_delta, on_hand_after, reserved_after)
  values (p_product, p_on_hand - p_reserved, p_reason, p_order, p_actor, p_note,
          p_on_hand, p_reserved, n_oh, n_rs);
end $$;

create or replace function reserve_stock(p_product_id text, p_qty int, p_order_id uuid, p_actor uuid)
returns void language plpgsql as $$
declare v inventory%rowtype;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'INVALID_QUANTITY: %', p_product_id using errcode = 'P0001'; end if;
  select * into v from inventory where product_id = p_product_id for update;
  if not found or v.stock_on_hand - v.stock_reserved < p_qty then
    raise exception 'INSUFFICIENT_STOCK: %', p_product_id using errcode = 'P0001';
  end if;
  perform _stock_move(p_product_id, 0, p_qty, 'order_reserved', p_order_id, p_actor, null);
end $$;

create or replace function release_stock(p_product_id text, p_qty int, p_order_id uuid, p_actor uuid,
                                         p_reason stock_reason default 'reservation_released')
returns void language plpgsql as $$
begin
  perform _stock_move(p_product_id, 0, -p_qty, p_reason, p_order_id, p_actor, null);
end $$;

create or replace function commit_stock(p_product_id text, p_qty int, p_order_id uuid, p_actor uuid)
returns void language plpgsql as $$
begin
  perform _stock_move(p_product_id, -p_qty, -p_qty, 'order_paid', p_order_id, p_actor, null);
end $$;

create or replace function adjust_stock(p_product_id text, p_delta int, p_reason stock_reason, p_actor uuid,
                                        p_note text default null)
returns void language plpgsql as $$
declare v inventory%rowtype;
begin
  if p_delta is null or p_delta = 0 then raise exception 'INVALID_ADJUSTMENT: change must not be zero' using errcode = 'P0001'; end if;
  if p_reason::text not in ('restock','correction','manual_adjustment','damage','expiry','initial_stock') then
    raise exception 'INVALID_ADJUSTMENT: reason not allowed for manual changes' using errcode = 'P0001';
  end if;
  if p_reason::text in ('restock','initial_stock') and p_delta < 0 then
    raise exception 'INVALID_ADJUSTMENT: % must add stock', p_reason using errcode = 'P0001';
  end if;
  if p_reason::text in ('damage','expiry') and p_delta > 0 then
    raise exception 'INVALID_ADJUSTMENT: % must remove stock', p_reason using errcode = 'P0001';
  end if;
  select * into v from inventory where product_id = p_product_id for update;
  if not found then raise exception 'INVALID_ADJUSTMENT: product has no inventory record' using errcode = 'P0001'; end if;
  if v.stock_on_hand + p_delta < 0 or v.stock_on_hand + p_delta < v.stock_reserved then
    raise exception 'INVALID_ADJUSTMENT: would leave less stock than is reserved or below zero' using errcode = 'P0001';
  end if;
  perform _stock_move(p_product_id, p_delta, 0, p_reason, null, p_actor, p_note);
end $$;

-- Release every reservation still held by an order. Idempotent: a line that is
-- no longer 'reserved' is skipped, so it can never be released twice.
create or replace function release_order_stock(p_order_id uuid, p_actor uuid,
                                               p_reason stock_reason default 'reservation_released')
returns void language plpgsql as $$
declare i record;
begin
  for i in select id, product_id, quantity from order_items
            where order_id = p_order_id and stock_state = 'reserved' order by product_id for update loop
    perform release_stock(i.product_id, i.quantity, p_order_id, p_actor, p_reason);
    update order_items set stock_state = 'released' where id = i.id;
  end loop;
end $$;

-- Permanently deduct stock for an order. Idempotent for the same reason.
create or replace function commit_order_stock(p_order_id uuid, p_actor uuid)
returns void language plpgsql as $$
declare i record;
begin
  for i in select id, product_id, quantity from order_items
            where order_id = p_order_id and stock_state = 'reserved' order by product_id for update loop
    perform commit_stock(i.product_id, i.quantity, p_order_id, p_actor);
    update order_items set stock_state = 'committed' where id = i.id;
  end loop;
end $$;

-- --------------------------------------------------------- order creation
create or replace function resolve_delivery(p_profile uuid, p_method delivery_method, p_address_id uuid, p_subtotal numeric)
returns jsonb language plpgsql stable as $$
declare v_cfg jsonb := app_setting('delivery', '{}'::jsonb); v_addr jsonb; v_fee numeric := 0;
begin
  if p_method = 'collection' then return jsonb_build_object('fee', 0, 'address', null); end if;
  if coalesce((v_cfg->>'enabled')::boolean, true) is false then
    raise exception 'DELIVERY_UNAVAILABLE' using errcode = 'P0001';
  end if;
  select to_jsonb(a) - 'profile_id' into v_addr from addresses a where a.id = p_address_id and a.profile_id = p_profile;
  if v_addr is null then raise exception 'ADDRESS_REQUIRED' using errcode = 'P0001'; end if;
  v_fee := coalesce((v_cfg->>'flat_fee')::numeric, 0);
  if v_cfg->>'free_over' is not null and p_subtotal >= (v_cfg->>'free_over')::numeric then v_fee := 0; end if;
  return jsonb_build_object('fee', round(v_fee, 2), 'address', v_addr);
end $$;

-- Inserts the order row, retrying only on an order-number collision.
create or replace function insert_order(p_id uuid, p_profile uuid, p_quote uuid, p_subtotal numeric, p_fee numeric,
                                        p_method delivery_method, p_address jsonb, p_notes text, p_idem text)
returns text language plpgsql as $$
declare
  v_attempt int := 0; v_number text; v_constraint text;
  v_hours int := coalesce((app_setting('order_expiry_hours', '48'::jsonb) #>> '{}')::int, 48);
  v_terms text := coalesce(app_setting('terms_version', '"1.0"'::jsonb) #>> '{}', '1.0');
begin
  loop
    v_attempt := v_attempt + 1;
    v_number := 'NGU-' || (100000 + floor(random() * 900000))::int::text;
    begin
      insert into orders(id, order_number, profile_id, quote_id, status, subtotal, delivery_fee, total,
                         payment_reference, delivery_method, address_snapshot, notes, terms_version,
                         expires_at, idempotency_key, delivery_status)
      values (p_id, v_number, p_profile, p_quote, 'pending_payment', p_subtotal, p_fee, p_subtotal + p_fee,
              v_number, p_method, p_address, p_notes, v_terms,
              now() + make_interval(hours => v_hours), p_idem,
              case when p_method = 'delivery' then 'pending' else 'not_applicable' end);
      return v_number;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from 'orders_order_number_key' or v_attempt >= 10 then raise; end if;
    end;
  end loop;
end $$;

create or replace function create_order_tx(p_profile_id uuid, p_items jsonb, p_delivery_method delivery_method,
                                           p_address_id uuid default null, p_notes text default null,
                                           p_idempotency_key text default null)
returns jsonb language plpgsql as $$
declare
  v_existing uuid; v_order_id uuid := gen_random_uuid(); v_lines jsonb; v_line record; v_prod products%rowtype;
  v_subtotal numeric(12,2) := 0; v_res jsonb; v_number text;
begin
  if p_idempotency_key is not null then
    select id into v_existing from orders where profile_id = p_profile_id and idempotency_key = p_idempotency_key;
    if found then return order_json(v_existing) || '{"replayed": true}'::jsonb; end if;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ORDER' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) > 50 then raise exception 'TOO_MANY_LINES' using errcode = 'P0001'; end if;

  -- Merge duplicate product lines, in a deterministic order (prevents lock-order deadlocks).
  select jsonb_agg(jsonb_build_object('pid', pid, 'qty', qty) order by pid) into v_lines
    from (select e->>'product_id' as pid, sum((e->>'quantity')::int)::int as qty
            from jsonb_array_elements(p_items) e group by 1) x;

  -- Lock the products for the life of this transaction: a price change cannot slip in mid-order.
  perform 1 from products where id in (select e->>'pid' from jsonb_array_elements(v_lines) e) order by id for share;

  for v_line in select e->>'pid' as pid, (e->>'qty')::int as qty from jsonb_array_elements(v_lines) e loop
    if v_line.pid is null or v_line.qty is null or v_line.qty < 1 or v_line.qty > 9999 then
      raise exception 'INVALID_QUANTITY: %', coalesce(v_line.pid, '?') using errcode = 'P0001';
    end if;
    select * into v_prod from products where id = v_line.pid;
    if not found or not v_prod.is_active then raise exception 'PRODUCT_UNAVAILABLE: %', v_line.pid using errcode = 'P0001'; end if;
    if v_prod.fulfilment_type = 'quote_only' then raise exception 'QUOTE_ONLY_PRODUCT: %', v_line.pid using errcode = 'P0001'; end if;
    v_subtotal := v_subtotal + v_prod.price * v_line.qty;
  end loop;

  v_res := resolve_delivery(p_profile_id, p_delivery_method, p_address_id, v_subtotal);
  v_number := insert_order(v_order_id, p_profile_id, null, v_subtotal, (v_res->>'fee')::numeric,
                           p_delivery_method, nullif(v_res->'address', 'null'::jsonb), p_notes, p_idempotency_key);

  for v_line in select e->>'pid' as pid, (e->>'qty')::int as qty from jsonb_array_elements(v_lines) e loop
    select * into v_prod from products where id = v_line.pid;
    insert into order_items(order_id, product_id, product_name, unit_price, quantity, line_total, stock_state)
    values (v_order_id, v_prod.id, v_prod.name, v_prod.price, v_line.qty, v_prod.price * v_line.qty,
            case when v_prod.fulfilment_type = 'stocked' then 'reserved' else 'none' end);
    if v_prod.fulfilment_type = 'stocked' then
      perform reserve_stock(v_prod.id, v_line.qty, v_order_id, p_profile_id);
    end if;
  end loop;

  perform log_order_status(v_order_id, null, 'pending_payment', p_profile_id, 'Order placed');
  perform log_audit(p_profile_id, 'order.create', 'order', v_order_id::text, null, order_json(v_order_id));
  return order_json(v_order_id);
end $$;

-- --------------------------------------------------------------- payments
create or replace function submit_payment_tx(p_order_id uuid, p_profile_id uuid, p_file_id uuid)
returns jsonb language plpgsql as $$
declare o orders%rowtype;
begin
  select * into o from orders where id = p_order_id for update;
  if not found or o.profile_id <> p_profile_id then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if o.status not in ('pending_payment', 'payment_rejected') then raise exception 'INVALID_STATE' using errcode = 'P0001'; end if;
  insert into payments(order_id, status, proof_file_id) values (p_order_id, 'pending', p_file_id);
  update orders set status = 'payment_submitted', status_changed_at = now() where id = p_order_id;
  perform log_order_status(p_order_id, o.status, 'payment_submitted', p_profile_id, 'Proof of payment uploaded');
  perform log_audit(p_profile_id, 'payment.submit', 'order', p_order_id::text, null, jsonb_build_object('file_id', p_file_id));
  return order_json(p_order_id);
end $$;

create or replace function confirm_payment_tx(p_order_id uuid, p_actor uuid, p_bank_ref text default null)
returns jsonb language plpgsql as $$
declare o orders%rowtype; pay payments%rowtype; v_before jsonb;
begin
  select * into o from orders where id = p_order_id for update;   -- serialises double-clicks
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if o.status = 'paid' or o.paid_at is not null then raise exception 'ALREADY_CONFIRMED' using errcode = 'P0001'; end if;
  if o.status <> 'payment_submitted' then raise exception 'INVALID_STATE' using errcode = 'P0001'; end if;
  select * into pay from payments where order_id = p_order_id and status = 'pending'
   order by submitted_at desc limit 1 for update;
  if not found then raise exception 'NO_PAYMENT_SUBMITTED' using errcode = 'P0001'; end if;

  v_before := order_json(p_order_id);
  perform commit_order_stock(p_order_id, p_actor);
  update payments set status = 'confirmed', verified_by = p_actor, verified_at = now(),
         bank_statement_ref = nullif(trim(p_bank_ref), '') where id = pay.id;
  update orders set status = 'paid', paid_at = now(), status_changed_at = now() where id = p_order_id;
  perform log_order_status(p_order_id, o.status, 'paid', p_actor, 'Payment confirmed');
  perform log_audit(p_actor, 'payment.confirm', 'order', p_order_id::text, v_before, order_json(p_order_id));
  return order_json(p_order_id);
end $$;

create or replace function reject_payment_tx(p_order_id uuid, p_actor uuid, p_reason text)
returns jsonb language plpgsql as $$
declare o orders%rowtype; pay payments%rowtype; v_hours int := coalesce((app_setting('order_expiry_hours', '48'::jsonb) #>> '{}')::int, 48);
begin
  if p_reason is null or char_length(trim(p_reason)) < 3 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if o.status <> 'payment_submitted' then raise exception 'INVALID_STATE' using errcode = 'P0001'; end if;
  select * into pay from payments where order_id = p_order_id and status = 'pending'
   order by submitted_at desc limit 1 for update;
  if not found then raise exception 'NO_PAYMENT_SUBMITTED' using errcode = 'P0001'; end if;

  update payments set status = 'rejected', verified_by = p_actor, verified_at = now(), reject_reason = trim(p_reason)
   where id = pay.id;
  -- Give the customer a fresh window to re-upload; the expiry job covers rejected orders too.
  update orders set status = 'payment_rejected', status_changed_at = now(),
         expires_at = now() + make_interval(hours => v_hours) where id = p_order_id;
  perform log_order_status(p_order_id, o.status, 'payment_rejected', p_actor, trim(p_reason));
  perform log_audit(p_actor, 'payment.reject', 'order', p_order_id::text, null, jsonb_build_object('reason', trim(p_reason)));
  return order_json(p_order_id);
end $$;

-- ------------------------------------------------------ cancel / lifecycle
-- Customers: only while pending_payment. Staff: any open state, reason required.
-- Cancelling BEFORE payment releases the reservation. Cancelling AFTER payment
-- does NOT touch stock (it was already committed): per the SRS, operations
-- returns goods to stock with an explicit, logged manual adjustment.
create or replace function cancel_order_tx(p_order_id uuid, p_actor uuid, p_is_staff boolean, p_reason text default null)
returns jsonb language plpgsql as $$
declare o orders%rowtype; v_before jsonb;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not p_is_staff then
    if o.profile_id <> p_actor then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
    if o.status <> 'pending_payment' then raise exception 'CANNOT_CANCEL' using errcode = 'P0001'; end if;
  else
    if p_reason is null or char_length(trim(p_reason)) < 3 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
    if o.status not in ('pending_payment','payment_submitted','payment_rejected','paid','processing','ready') then
      raise exception 'CANNOT_CANCEL' using errcode = 'P0001';
    end if;
  end if;

  v_before := order_json(p_order_id);
  perform release_order_stock(p_order_id, p_actor, 'reservation_released');
  update payments set status = 'rejected', verified_by = p_actor, verified_at = now(),
         reject_reason = 'Order cancelled' where order_id = p_order_id and status = 'pending';
  update orders set status = 'cancelled', cancel_reason = nullif(trim(p_reason), ''), status_changed_at = now()
   where id = p_order_id;
  perform log_order_status(p_order_id, o.status, 'cancelled', p_actor, nullif(trim(p_reason), ''));
  perform log_audit(p_actor, 'order.cancel', 'order', p_order_id::text, v_before, order_json(p_order_id));
  return order_json(p_order_id);
end $$;

-- Explicit state machine for fulfilment: paid -> processing -> ready -> completed.
create or replace function set_order_status_tx(p_order_id uuid, p_actor uuid, p_to order_status, p_note text default null)
returns jsonb language plpgsql as $$
declare o orders%rowtype; v_ok boolean;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_ok := (o.status = 'paid' and p_to = 'processing')
       or (o.status = 'processing' and p_to = 'ready')
       or (o.status = 'ready' and p_to = 'completed');
  if not v_ok then raise exception 'INVALID_TRANSITION: % -> %', o.status, p_to using errcode = 'P0001'; end if;
  update orders set status = p_to, status_changed_at = now(),
         delivery_status = case when p_to = 'completed' and o.delivery_method = 'delivery' then 'delivered' else o.delivery_status end
   where id = p_order_id;
  perform log_order_status(p_order_id, o.status, p_to, p_actor, p_note);
  perform log_audit(p_actor, 'order.status', 'order', p_order_id::text,
                    jsonb_build_object('status', o.status), jsonb_build_object('status', p_to));
  return order_json(p_order_id);
end $$;

create or replace function set_delivery_status_tx(p_order_id uuid, p_actor uuid, p_status text)
returns jsonb language plpgsql as $$
declare o orders%rowtype;
begin
  if p_status not in ('pending','dispatched','delivered') then raise exception 'INVALID_DELIVERY_STATUS' using errcode = 'P0001'; end if;
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if o.delivery_method <> 'delivery' then raise exception 'NOT_A_DELIVERY_ORDER' using errcode = 'P0001'; end if;
  if o.status not in ('processing','ready','completed') then raise exception 'INVALID_STATE' using errcode = 'P0001'; end if;
  update orders set delivery_status = p_status where id = p_order_id;
  perform log_audit(p_actor, 'order.delivery_status', 'order', p_order_id::text,
                    jsonb_build_object('delivery_status', o.delivery_status), jsonb_build_object('delivery_status', p_status));
  return order_json(p_order_id);
end $$;

-- Safe to run repeatedly and concurrently: rows are claimed with SKIP LOCKED and
-- the status change happens in the same transaction as the stock release.
create or replace function expire_unpaid_orders() returns int language plpgsql as $$
declare o record; v_count int := 0;
begin
  for o in select id, status from orders
            where status in ('pending_payment','payment_rejected') and expires_at is not null and expires_at < now()
            order by expires_at for update skip locked loop
    perform release_order_stock(o.id, null, 'reservation_expired');
    update orders set status = 'expired', status_changed_at = now(),
           cancel_reason = 'Payment was not received within the allowed time' where id = o.id;
    perform log_order_status(o.id, o.status, 'expired', null, 'Expired by system');
    perform log_audit(null, 'order.expire', 'order', o.id::text, jsonb_build_object('status', o.status), jsonb_build_object('status', 'expired'));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ----------------------------------------------------------------- quotes
create or replace function issue_quote_tx(p_request_id uuid, p_actor uuid, p_amount numeric, p_notes text, p_valid_until timestamptz)
returns jsonb language plpgsql as $$
declare r quote_requests%rowtype; q quotes%rowtype;
begin
  select * into r from quote_requests where id = p_request_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if r.status = 'closed' then raise exception 'REQUEST_CLOSED' using errcode = 'P0001'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT' using errcode = 'P0001'; end if;
  if p_valid_until is null or p_valid_until <= now() then raise exception 'INVALID_VALIDITY' using errcode = 'P0001'; end if;

  update quotes set status = 'expired' where quote_request_id = p_request_id and status = 'issued'; -- supersede
  insert into quotes(quote_request_id, amount, notes, valid_until, prepared_by)
  values (p_request_id, round(p_amount, 2), nullif(trim(p_notes), ''), p_valid_until, p_actor) returning * into q;
  update quote_requests set status = 'quoted', assigned_to = coalesce(assigned_to, p_actor) where id = p_request_id;
  perform log_audit(p_actor, 'quote.issue', 'quote', q.id::text, null, to_jsonb(q));
  return to_jsonb(q);
end $$;

create or replace function respond_quote_tx(p_quote_id uuid, p_profile_id uuid, p_accept boolean,
                                            p_delivery_method delivery_method default null,
                                            p_address_id uuid default null, p_notes text default null)
returns jsonb language plpgsql as $$
declare q quotes%rowtype; r quote_requests%rowtype; v_order_id uuid := gen_random_uuid(); v_res jsonb; v_number text;
begin
  select * into q from quotes where id = p_quote_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into r from quote_requests where id = q.quote_request_id for update;
  if r.profile_id <> p_profile_id then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if q.status <> 'issued' then raise exception 'QUOTE_NOT_OPEN' using errcode = 'P0001'; end if;
  if q.valid_until < now() then raise exception 'QUOTE_EXPIRED' using errcode = 'P0001'; end if;

  if not p_accept then
    update quotes set status = 'declined', responded_at = now() where id = q.id;
    update quote_requests set status = 'closed' where id = r.id;
    perform log_audit(p_profile_id, 'quote.decline', 'quote', q.id::text);
    return jsonb_build_object('declined', true);
  end if;

  if p_delivery_method is null then raise exception 'DELIVERY_METHOD_REQUIRED' using errcode = 'P0001'; end if;
  -- Priced at the QUOTED amount, never at a catalogue price.
  v_res := resolve_delivery(p_profile_id, p_delivery_method, p_address_id, q.amount);
  v_number := insert_order(v_order_id, p_profile_id, q.id, q.amount, (v_res->>'fee')::numeric,
                           p_delivery_method, nullif(v_res->'address', 'null'::jsonb), p_notes, null);
  insert into order_items(order_id, product_id, product_name, unit_price, quantity, line_total, is_custom, stock_state)
  values (v_order_id, null, 'Custom quote: ' || r.title, q.amount, 1, q.amount, true, 'none');

  update quotes set status = 'accepted', responded_at = now() where id = q.id;
  update quote_requests set status = 'closed' where id = r.id;
  perform log_order_status(v_order_id, null, 'pending_payment', p_profile_id, 'Order created from accepted quote');
  perform log_audit(p_profile_id, 'quote.accept', 'quote', q.id::text, null, jsonb_build_object('order_id', v_order_id));
  return jsonb_build_object('order', order_json(v_order_id));
end $$;

-- Expired quotes can no longer be accepted; the request goes back to sales for re-pricing.
create or replace function expire_quotes() returns int language plpgsql as $$
declare v_count int;
begin
  with e as (update quotes set status = 'expired' where status = 'issued' and valid_until < now()
             returning quote_request_id)
  select count(*) into v_count from e;
  update quote_requests r set status = 'in_review'
   where r.status = 'quoted' and not exists (select 1 from quotes q where q.quote_request_id = r.id and q.status in ('issued','accepted'));
  return v_count;
end $$;

-- ------------------------------------------------------------- dashboard
create or replace function dashboard_stats() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'orders_by_status', coalesce((select jsonb_object_agg(status, c) from (select status, count(*) c from orders group by status) s), '{}'::jsonb),
    'pending_payments', (select count(*) from orders where status = 'payment_submitted'),
    'revenue_total', coalesce((select sum(total) from orders where paid_at is not null and status <> 'cancelled'), 0),
    'revenue_30d', coalesce((select sum(total) from orders where paid_at > now() - interval '30 days' and status <> 'cancelled'), 0),
    'products_active', (select count(*) from products where is_active),
    'products_total', (select count(*) from products),
    'low_stock', (select count(*) from inventory i join products p on p.id = i.product_id
                   where p.is_active and i.stock_on_hand - i.stock_reserved <= p.low_stock_threshold),
    'customers', (select count(*) from profiles where role = 'client'),
    'quote_requests_open', (select count(*) from quote_requests where status in ('submitted','in_review')),
    'tickets_open', (select count(*) from tickets where status in ('open','in_progress','waiting_client')),
    'messages_new', (select count(*) from contact_messages where status = 'new')
  )
$$;

-- --------------------------------------------------------------- privileges
-- Supabase exposes every function in `public` over PostgREST (/rest/v1/rpc/*) to
-- the public anon key. These are server-only, so lock them to service_role.
-- (Re-run this block after adding any new function in a later migration.)
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
