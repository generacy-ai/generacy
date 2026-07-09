import { z } from 'zod';
import { CockpitEventSchema } from './emit.js';
import { PhaseCompleteEventSchema, EpicCompleteEventSchema } from './aggregate-emit.js';

export const CockpitStreamEventSchema = z.discriminatedUnion('type', [
  CockpitEventSchema,
  PhaseCompleteEventSchema,
  EpicCompleteEventSchema,
]);

export type CockpitStreamEvent = z.infer<typeof CockpitStreamEventSchema>;
