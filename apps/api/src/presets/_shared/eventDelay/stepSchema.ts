import { z } from 'zod';
import {
  EventDelayStepSchema,
  AnnualDateStepSchema,
  CampaignStepSchema,
  DelaySpecSchema,
  OfferRefSchema,
} from '@grovastra/shared';

export {
  DelaySpecSchema,
  OfferRefSchema,
  EventDelayStepSchema,
  AnnualDateStepSchema,
  CampaignStepSchema,
};

export const EventDelayCampaignStepSchema = EventDelayStepSchema;
export type EventDelayStepInput = z.infer<typeof EventDelayStepSchema>;
