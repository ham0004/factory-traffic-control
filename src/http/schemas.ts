import { z } from 'zod';

const direction = z.enum(['NORTH', 'SOUTH', 'EAST', 'WEST']);
const vehicleType = z.enum(['EMPLOYEE_VEHICLE', 'FORKLIFT', 'TRUCK', 'EMERGENCY']);
const observedColor = z.enum(['RED', 'YELLOW', 'GREEN', 'UNKNOWN']);
const signals = z.object({ NORTH: observedColor, SOUTH: observedColor, EAST: observedColor, WEST: observedColor });
const id = z.string().trim().min(1).max(100);
const timestamp = z.iso.datetime({ offset: true });

const sensorBase = {
  event_id: id,
  junction_id: id,
  direction,
  vehicle_id: id,
  sequence_no: z.number().int().nonnegative(),
  timestamp,
};

export const sensorEventSchema = z.discriminatedUnion('event_type', [
  z.object({ ...sensorBase, event_type: z.literal('VEHICLE_ARRIVED'), vehicle_type: vehicleType }),
  z.object({ ...sensorBase, event_type: z.literal('VEHICLE_CLEARED'), vehicle_type: vehicleType.optional() }),
]);

export const commandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('MANUAL_GREEN_REQUEST'), direction, issued_by: z.string().max(100).optional() }),
  z.object({ command: z.literal('RETURN_TO_AUTOMATIC'), issued_by: z.string().max(100).optional() }),
]);

// Changed from the spec: the ACK carries the full signal map instead of one actual_state,
// because a single command covers the whole junction.
export const controllerEventSchema = z.discriminatedUnion('status', [
  z.object({ command_id: id, junction_id: id, status: z.literal('ACK'), actual_signals: signals, timestamp: timestamp.optional() }),
  z.object({
    command_id: id,
    junction_id: id,
    status: z.literal('NACK'),
    actual_signals: signals.optional(),
    reason: z.string().max(200).optional(),
    timestamp: timestamp.optional(),
  }),
]);

export const deviceStatusSchema = z.discriminatedUnion('device_type', [
  z.object({
    event_id: id.optional(),
    junction_id: id,
    device_type: z.literal('SIGNAL_CONTROLLER'),
    direction: direction.optional(),
    status: z.enum(['ONLINE', 'OFFLINE']),
    timestamp: timestamp.optional(),
  }),
  z.object({
    event_id: id.optional(),
    junction_id: id,
    device_type: z.literal('SENSOR'),
    direction,
    status: z.enum(['ONLINE', 'OFFLINE']),
    timestamp: timestamp.optional(),
  }),
]);

const positiveMs = z.number().int().positive().max(3_600_000);

export const createJunctionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/, 'use letters, digits, - or _ (max 20)'),
  name: z.string().trim().min(1).max(100),
  config: z
    .object({
      phases: z
        .record(z.string().regex(/^[A-Z_]{1,40}$/), z.array(direction).min(1))
        .refine((phases) => Object.keys(phases).length >= 2, 'at least two phases are needed')
        .refine((phases) => {
          const all = Object.values(phases).flat();
          return new Set(all).size === all.length;
        }, 'a direction can only belong to one phase')
        .optional(),
      timings: z
        .object({
          minGreenMs: positiveMs,
          normalGreenMs: positiveMs,
          maxGreenMs: positiveMs,
          yellowMs: positiveMs,
          allRedMs: positiveMs,
          ackTimeoutMs: positiveMs,
          degradedResendMs: positiveMs,
        })
        .partial()
        .optional(),
      vehicleWeights: z.record(vehicleType, z.number().nonnegative()).optional(),
    })
    .optional(),
});

export const simulatorSettingsSchema = z.object({
  auto_ack: z.boolean().optional(),
  ack_delay_ms: z.number().int().min(0).max(10_000).optional(),
});

export function formatIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}
