-- seed_settings.sql: default application settings. Never overwrites a value an
-- administrator has already saved. All of these are editable in Admin > Settings.
insert into settings (key, value) values
  ('bank_details', '{"bank":"","account_name":"","account_number":"","branch_code":"","account_type":"","notes":""}'),
  ('order_expiry_hours', '48'),
  ('terms_version', '"1.0"'),
  ('low_stock_default', '5'),
  ('collection_address', '"Chobe Street, Windhoek"'),
  ('delivery', '{"enabled":true,"flat_fee":0,"free_over":null,"note":"Delivery fee is confirmed by our team."}'),
  ('notifications', '{"finance_email":"","sales_email":"","support_email":"","contact_email":""}')
on conflict (key) do nothing;
