import { z } from 'zod';
import { CockpitEventSchema } from './emit.js';
import { PhaseCompleteEventSchema, EpicCompleteEventSchema } from './aggregate-emit.js';
import { GateAnswerEventSchema } from './gate-answer.js';

export const CockpitStreamEventSchema = z.discriminatedUnion('type', [
  CockpitEventSchema,
  PhaseCompleteEventSchema,
  EpicCompleteEventSchema,
  GateAnswerEventSchema,
]);

export type CockpitStreamEvent = z.infer<typeof CockpitStreamEventSchema>;
