-- demo_stock.sql  --  DEMO ONLY. Gives the stocked products some opening stock so the
-- store can be tried out immediately. These quantities are placeholders, NOT real
-- inventory: do not run this on a production database.
select adjust_stock('sg-stamps', 40, 'initial_stock', null, 'Demo opening stock');
select adjust_stock('pr-cards',  60, 'initial_stock', null, 'Demo opening stock');
select adjust_stock('pr-flyers', 30, 'initial_stock', null, 'Demo opening stock');
select adjust_stock('pr-pullup', 25, 'initial_stock', null, 'Demo opening stock');
