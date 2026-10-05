-- 002_tables.sql
-- Core tables. profiles.id mirrors auth.users.id (Supabase Auth).

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  company text,
  role user_role not null default 'client',
  department staff_department,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint department_requires_employee check (
    (role = 'employee' and department is not null) or
    (role <> 'employee' and department is null)
  )
);

create table addresses (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  label text not null default 'Main',
  line1 text not null,
  line2 text,
  town text not null,
  region text,
  notes text,
  created_at timestamptz not null default now()
);

create table categories (
  id text primary key,             -- slug, e.g. 'signage'
  label text not null,
  sort_order int not null default 0
);

create table products (
  id text primary key,             -- sku, e.g. 'sg6'
  category_id text not null references categories(id),
  name text not null,
  description text not null default '',
  price numeric(12,2) not null check (price >= 0),
  unit text not null default 'each',
  price_is_from boolean not null default false,
  fulfilment_type fulfilment_type not null,
  lead_time_note text,
  image_url text,
  low_stock_threshold int not null default 5,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table inventory (
  product_id text primary key references products(id) on delete cascade,
  stock_on_hand int not null default 0,
  stock_reserved int not null default 0,
  constraint stock_on_hand_nonneg check (stock_on_hand >= 0),
  constraint stock_reserved_nonneg check (stock_reserved >= 0),
  constraint stock_reserved_le_on_hand check (stock_reserved <= stock_on_hand)
);

create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references products(id),
  delta int not null,
  reason stock_reason not null,
  order_id uuid,
  actor_id uuid references profiles(id),
  note text,
  created_at timestamptz not null default now()
);

create table quote_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id),
  product_id text references products(id),
  title text not null,
  description text not null default '',
  specs jsonb not null default '{}'::jsonb, -- {width,height,unit,quantity,notes}
  status quote_request_status not null default 'submitted',
  assigned_to uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table quotes (
  id uuid primary key default gen_random_uuid(),
  quote_request_id uuid not null references quote_requests(id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  notes text,
  valid_until timestamptz not null,
  status quote_status not null default 'issued',
  prepared_by uuid not null references profiles(id),
  responded_at timestamptz,
  created_at timestamptz not null default now()
);

create table files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id),
  bucket_path text not null,
  original_name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 5242880),
  purpose file_purpose not null,
  created_at timestamptz not null default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  profile_id uuid not null references profiles(id),
  quote_id uuid references quotes(id),
  status order_status not null default 'pending_payment',
  subtotal numeric(12,2) not null default 0,
  delivery_fee numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  payment_reference text not null,
  delivery_method delivery_method not null,
  address_snapshot jsonb,
  notes text,
  terms_accepted_at timestamptz not null default now(),
  terms_version text not null,
  expires_at timestamptz,
  paid_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id text not null references products(id),
  product_name text not null,
  unit_price numeric(12,2) not null,
  quantity int not null check (quantity > 0),
  line_total numeric(12,2) not null
);

alter table stock_movements
  add constraint stock_movements_order_fk foreign key (order_id) references orders(id);

create table payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  status payment_status not null default 'pending',
  proof_file_id uuid references files(id),
  submitted_at timestamptz not null default now(),
  verified_by uuid references profiles(id),
  verified_at timestamptz,
  reject_reason text,
  bank_statement_ref text
);

create table tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_number text not null unique,
  profile_id uuid not null references profiles(id),
  category ticket_category not null default 'general',
  subject text not null,
  status ticket_status not null default 'open',
  order_id uuid references orders(id),
  assigned_to uuid references profiles(id),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,
  author_id uuid not null references profiles(id),
  body text not null,
  is_internal_note boolean not null default false,
  created_at timestamptz not null default now()
);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references profiles(id),
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  ip text,
  created_at timestamptz not null default now()
);

-- Indexes
create index idx_orders_profile on orders(profile_id);
create index idx_orders_status on orders(status);
create index idx_orders_expires on orders(expires_at) where status = 'pending_payment';
create index idx_order_items_order on order_items(order_id);
create index idx_payments_status on payments(status);
create index idx_products_category on products(category_id);
create index idx_quote_requests_profile on quote_requests(profile_id);
create index idx_tickets_profile on tickets(profile_id);
create index idx_tickets_status on tickets(status);
create index idx_stock_movements_product on stock_movements(product_id);
create index idx_audit_log_entity on audit_log(entity, entity_id);
