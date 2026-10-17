import type { DemoContributor } from '../contributors.js';

import { seedNotifications } from './notifications.js';
import { seedOnlineBooking } from './online-booking.js';
import type { Stage3Context } from './shared.js';
import { seedTeleconsultation } from './teleconsultation.js';
import { seedWaitlist } from './waitlist.js';

/**
 * The Stage 3 part of the demo (tasks 3.71 to 3.73): video visits, the public booking with its
 * bookings, the waitlist and the message log that tells what happened around all of them. The order
 * matters: each part reads what the one before it left. Everything is written directly, with the
 * rules of the real services where they apply, and nothing is sent anywhere.
 */
export const seedStage3: DemoContributor = async (context: Stage3Context) => {
  // Times already given to a visit, so no two parts of the seed take the same one.
  const taken = new Set<string>();
  const teleconsultation = await seedTeleconsultation(context, taken);
  const onlineBooking = await seedOnlineBooking(context, taken);
  const waitlist = await seedWaitlist(context, taken);
  await seedNotifications(context, { teleconsultation, onlineBooking, waitlist });
};
