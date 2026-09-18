-- Put the head-office pin where head office actually is.
--
-- The HQ geofence was pinned at 29.3615133, 47.9663614 — presumably read off a
-- map. Every phone that has ever clocked in there disagrees with it: the 102
-- device fixes on record cluster 62 m to the west-south-west, and both the
-- median and the geometric median of them land on the same spot, so this is
-- the building as GPS sees it and not a handful of strays dragging an average.
--
-- It mattered the moment the radius was tightened to 120 m. Measured from the
-- old pin, 20 of those 102 clock-ins fall outside — one in five arrivals
-- refused while standing at their own desk. Measured from where the phones
-- actually sit, 10 do, and the average distance a person is recorded at drops
-- from 82 m to 50 m.
--
-- The centre chosen is the geometric median — the point closest to every fix
-- at once. A point chasing maximum coverage instead sits 73 m the other way
-- and covers 96, but only by pushing the circle off the building to swallow
-- the strays, which buys those six clock-ins by admitting the road.
--
-- The radius stays 120 m. What is left outside is not scatter: all ten are
-- one person across August (avg 122 m, up to 213 m), whose July and September
-- clock-ins sit 35–43 m out like everybody else's. That is a question for a
-- manager, not a number for the geofence to bend around.

update public.geofences
   set lat = 29.3612368,
       lng = 47.9658062
 where name = 'Timekeeper HQ';

-- Recorded distances were measured against the old centre, so they no longer
-- describe the fence they name. Re-measure the history against the fence each
-- row was filed at, so "39 m" on an August row and on a January one mean the
-- same thing.
update public.attendance_records a
   set clock_in_distance_m = (
         select round(geo_distance_m(a.clock_in_lat, a.clock_in_lng, g.lat, g.lng))
           from public.geofences g
          where g.name = a.location
          limit 1)
 where a.clock_in_lat is not null
   and exists (select 1 from public.geofences g where g.name = a.location);

update public.attendance_records a
   set clock_out_distance_m = (
         select round(geo_distance_m(a.clock_out_lat, a.clock_out_lng, g.lat, g.lng))
           from public.geofences g
          where g.name = a.location
          limit 1)
 where a.clock_out_lat is not null
   and exists (select 1 from public.geofences g where g.name = a.location);
