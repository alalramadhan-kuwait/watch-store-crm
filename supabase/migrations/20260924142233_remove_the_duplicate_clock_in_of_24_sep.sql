-- The second of two clock-ins that went through ten seconds apart on 24 Sep
-- (Eman Salman, 09:28:03, closed 16:18:45). The first record, 09:27:53 to
-- 16:18:31, stays. Approved by the owner. Across every account this was the
-- only pair of clock-ins less than five minutes apart. The audit log keeps a
-- copy of the row.
delete from public.attendance_records
 where id = '5873070c-830f-4a88-b7ab-bd369cd4c36f'
   and exists (select 1 from public.attendance_records k
                where k.id = '176e8652-3410-446d-af54-871bba45b3a9'
                  and k.user_id = attendance_records.user_id);
