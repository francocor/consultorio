import type { SchedulingPorts } from '../../scheduling/index.js';

/**
 * The scheduling ports as the public flows see them: capacity 1, whatever the professional allows
 * (design 4.6, "Public flows use capacity 1, never an overbooking lane"). The professional reads as
 * a single-lane one and every occupancy reads as lane 1, so a slot is free only when NOTHING takes
 * any part of it, which is exactly what a public hold will require when it is written.
 *
 * Availability asks scheduling through this wrapper; the holds themselves are written with the real
 * ports and the `public` origin, so the rule is enforced twice and cannot drift apart.
 */
export function publicCapacityPorts(ports: SchedulingPorts): SchedulingPorts {
  return {
    ...ports,
    async findProfessional(id) {
      const found = await ports.findProfessional(id);
      return found ? { ...found, maxSimultaneous: 1 } : null;
    },
    async occupancies(professionalId, range) {
      const found = await ports.occupancies(professionalId, range);
      return found.map((occupancy) => ({ ...occupancy, lane: 1 }));
    },
  };
}
