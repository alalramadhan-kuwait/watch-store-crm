-- MAI-2091 (Baltic, 370.42 KD) had its amount paid typed as 370,999,999,999,996
-- on 2 Aug; the audit log shows the value before that edit was 370. Put back.
-- (Applied first by hand on 16 Oct; recorded here so the folder matches the
-- database. The condition makes this a no-op once corrected.)
update public.purchase_orders set amount_paid = 370
 where po_number = 'MAI-2091' and source = 'lightspeed' and amount_paid = 370999999999996;
