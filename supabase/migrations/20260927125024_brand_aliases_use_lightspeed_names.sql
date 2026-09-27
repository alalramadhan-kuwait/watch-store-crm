-- Arabic brand spellings point at the brand as Lightspeed names it, so ad
-- spend and sales land on the same line of "What we're pushing".
update public.marketing_brand_aliases set brand = 'Behrens Original' where brand = 'Behrens';
update public.marketing_brand_aliases set brand = 'Casio Gshock' where brand in ('Casio', 'G-Shock');
