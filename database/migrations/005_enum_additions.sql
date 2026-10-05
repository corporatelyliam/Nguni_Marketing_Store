-- 005_enum_additions.sql
-- Kept in its own file: PostgreSQL cannot use a newly added enum value inside the
-- same transaction that adds it, and some SQL runners wrap a whole file in one.

alter type stock_reason add value if not exists 'damage';
alter type stock_reason add value if not exists 'expiry';
alter type stock_reason add value if not exists 'reservation_expired';
alter type stock_reason add value if not exists 'initial_stock';
