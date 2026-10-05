-- seed_products.sql
-- Catalogue taken from the existing public/products.html page (names, prices, units,
-- images). Fulfilment types follow docs/01-PRD.md section 4. Safe to re-run.
--
-- Prices marked price_is_from are "From N$..." prices on the marketing site.
-- quote_only items with no listed price use price 0 and show "Get a quote" in the shop.
-- Stocked items start with ZERO stock; Operations restocks them in the staff dashboard
-- (or run database/seed/demo_stock.sql for demo quantities).

insert into categories (id, label, sort_order) values
  ('signage',     'Signage & Branding', 1),
  ('roadsigns',   'Road Signs',         2),
  ('billboards',  'Billboards',         3),
  ('namfree',     'NamFree Water',      4),
  ('activations', 'Activations',        5),
  ('print',       'Print',              6)
on conflict (id) do update set label = excluded.label, sort_order = excluded.sort_order;

insert into products (id, category_id, name, description, price, unit, price_is_from, fulfilment_type, lead_time_note, image_url, low_stock_threshold) values
  ('sg-illuminated', 'signage', '3D illuminated signs & lightboxes',
   '3D illuminated Perspex and Perspexbuild signs and lightboxes. High-impact signage that gets your business noticed day and night.',
   0, 'quote', false, 'quote_only', 'Priced on size and finish', 'images/campaigns/illuminated-signs-flyer.png', 5),
  ('sg-stamps', 'signage', 'Self-inking stamps',
   'Self-inking stamps for business and office use.',
   950, 'per set of 10', true, 'stocked', null, 'images/campaigns/self-inking-stamps-flyer.png', 5),
  ('sg-reception', 'signage', 'Reception sign package',
   'A complete reception sign, made to order for your space.',
   2400, 'per sign', true, 'made_to_order', 'Made to order', 'images/products/reception-sign.svg', 5),
  ('sg-frosting', 'signage', 'Window frosting & wall graphics',
   'Window frosting and wall graphics, measured and fitted to your premises.',
   1850, 'per m²', true, 'quote_only', 'Priced on measurements', 'images/products/window-frosting.svg', 5),
  ('sg-vehicle-wrap', 'signage', 'Vehicle full wrap',
   'Full vehicle wrap branding for single vehicles and fleets.',
   9800, 'per vehicle', true, 'quote_only', 'Priced on vehicle and design', 'images/products/vehicle-wrap.svg', 5),

  ('rs-sabs', 'roadsigns', 'SABS standard road signs',
   'SABS compliant road signs: warning, street name, information and directional signs.',
   0, 'quote', false, 'quote_only', 'Priced on site and sign type', 'images/campaigns/road-signs-flyer.png', 5),

  ('bb-static', 'billboards', 'Static billboards',
   'Static billboard advertising sites.',
   7200, 'per month', true, 'quote_only', null, 'images/products/static-billboard.svg', 5),
  ('bb-digital', 'billboards', 'Digital billboards',
   'Digital billboard advertising slots.',
   6500, 'per week', true, 'quote_only', null, 'images/products/digital-billboard.svg', 5),
  ('bb-mall', 'billboards', 'Mall advertising panels',
   'Advertising panels in shopping malls.',
   5400, 'per month', true, 'quote_only', null, 'images/products/mall-advertising.svg', 5),
  ('bb-airport', 'billboards', 'Airport advertising',
   'Airport advertising placements.',
   16800, 'per month', true, 'quote_only', null, 'images/products/airport-advertising.svg', 5),

  ('nf-starter', 'namfree', 'NamFreeWater - starter',
   'NamFreeWater starter campaign package.',
   2500, 'per day', true, 'made_to_order', 'Made to order', 'images/products/namfree-starter.svg', 5),
  ('nf-weekly', 'namfree', 'NamFreeWater - weekly campaign',
   'NamFreeWater weekly campaign package.',
   11000, 'per week', true, 'made_to_order', 'Made to order', 'images/products/namfree-campaign.svg', 5),

  ('ac-sampling', 'activations', 'In-store sampling team',
   'Trained in-store sampling team for your product.',
   3400, 'per day', true, 'made_to_order', 'Booked on request', 'images/products/instore-sampling.svg', 5),
  ('ac-launch', 'activations', 'Product launch activation',
   'End-to-end product launch activation.',
   12500, 'per event', true, 'made_to_order', 'Booked on request', 'images/products/product-launch.svg', 5),
  ('ac-promoter', 'activations', 'Promoter manpower',
   'Promoters supplied per day.',
   950, 'per promoter / day', true, 'made_to_order', 'Booked on request', 'images/products/promoter-manpower.svg', 5),

  ('pr-cards', 'print', 'Business cards',
   'Business cards printed to your design.',
   780, 'per 500', true, 'stocked', null, 'images/products/business-cards.svg', 5),
  ('pr-flyers', 'print', 'Flyers & posters',
   'Flyers and posters printed to your design.',
   1350, 'per 250', true, 'stocked', null, 'images/products/flyers-posters.svg', 5),
  ('pr-pullup', 'print', 'Pull-up banners',
   'Pull-up banners with carry case.',
   1650, 'each', true, 'stocked', null, 'images/products/pullup-banners.svg', 5)
on conflict (id) do update set
  category_id = excluded.category_id, name = excluded.name, description = excluded.description,
  unit = excluded.unit, price_is_from = excluded.price_is_from, lead_time_note = excluded.lead_time_note,
  image_url = case when products.image_path is not null then products.image_url else excluded.image_url end,
  fulfilment_type = excluded.fulfilment_type;
-- NOTE: re-running never overwrites a price an administrator has since changed
-- (price and low_stock_threshold are deliberately absent from the update list above).

-- Inventory rows for stocked products are created by the products_inventory_ensure trigger.
