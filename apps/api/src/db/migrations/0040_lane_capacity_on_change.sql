-- Judgment Day, Stage 2, round 1, finding S2: lowering a professional's capacity must not break
-- the appointments already booked in the lanes above it.
--
-- The capacity check ran on EVERY write of an occupancy row, so after the capacity went from 2 to
-- 1, any status change of an appointment in lane 2 (confirm, check in, cancel) failed with a raw
-- 23514. The capacity limits where an appointment can be PLACED, so it is checked when a row is
-- inserted, when it becomes active again, and when it changes lane or professional; an active
-- appointment that stays where it is keeps its lane.
CREATE OR REPLACE FUNCTION app.slot_occupancy_lane_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  capacity smallint;
BEGIN
  IF NOT NEW.active THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.active
     AND NEW.lane = OLD.lane
     AND NEW.professional_id = OLD.professional_id THEN
    RETURN NULL;
  END IF;
  SELECT p.max_simultaneous INTO capacity
    FROM public.professional p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.professional_id;
  IF capacity IS NULL OR NEW.lane > capacity THEN
    RAISE EXCEPTION 'lane % is above the capacity of the professional', NEW.lane
      USING ERRCODE = '23514', CONSTRAINT = 'slot_occupancy_lane_capacity';
  END IF;
  RETURN NULL;
END
$$;
