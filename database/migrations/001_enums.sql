-- 001_enums.sql
-- Enum types used across the schema.

create extension if not exists "pgcrypto"; -- gen_random_uuid()

create type user_role as enum ('client','employee','support','admin');
create type staff_department as enum ('finance','sales','operations');
create type fulfilment_type as enum ('stocked','made_to_order','quote_only');
create type order_status as enum (
  'pending_payment','payment_submitted','payment_rejected',
  'paid','processing','ready','completed','cancelled','expired'
);
create type payment_status as enum ('pending','confirmed','rejected');
create type delivery_method as enum ('collection','delivery');
create type quote_request_status as enum ('submitted','in_review','quoted','closed');
create type quote_status as enum ('issued','accepted','declined','expired');
create type ticket_status as enum ('open','in_progress','waiting_client','resolved','closed');
create type ticket_category as enum ('order','payment','technical','general');
create type stock_reason as enum (
  'order_reserved','reservation_released','order_paid','manual_adjustment','restock','correction'
);
create type file_purpose as enum ('payment_proof','quote_attachment','ticket_attachment');
