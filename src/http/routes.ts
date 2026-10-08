import { Router, type ErrorRequestHandler, type Response } from 'express';
import type { ZodError } from 'zod';
import type { RestSimulatorController } from '../adapters/restSimulatorController';
import { NotFoundError, type JunctionService } from '../app/junctionService';
import { DEFAULT_JUNCTION_CONFIG } from '../domain/config';
import type { DomainError, JunctionConfig } from '../domain/types';
import {
  commandSchema,
  controllerEventSchema,
  createJunctionSchema,
  deviceStatusSchema,
  formatIssues,
  sensorEventSchema,
  simulatorSettingsSchema,
} from './schemas';

function validationFailed(res: Response, status: 400 | 422, error: ZodError) {
  res.status(status).json({ error: 'VALIDATION_ERROR', details: formatIssues(error) });
}

function domainFailed(res: Response, error: DomainError, invalidStatus: 400 | 422) {
  res.status(error.kind === 'CONFLICT' ? 409 : invalidStatus).json({ error: error.code, message: error.message });
}

// Handlers only translate: validate the body, call the service, map the result to a status code.
export function createRouter(service: JunctionService, simulator: RestSimulatorController): Router {
  const router = Router();

  router.get('/junctions', (_req, res) => {
    res.json(service.listJunctions().map((j) => ({ id: j.id, name: j.name, created_at: j.createdAt })));
  });

  router.get('/junctions/:id', (req, res) => {
    const junction = service.getJunction(req.params.id);
    res.json({ id: junction.id, name: junction.name, config: junction.config, created_at: junction.createdAt });
  });

  router.post('/junctions', async (req, res) => {
    const parsed = createJunctionSchema.safeParse(req.body);
    if (!parsed.success) return validationFailed(res, 422, parsed.error);

    const { id, name, config } = parsed.data;
    const merged: JunctionConfig = {
      ...DEFAULT_JUNCTION_CONFIG,
      phases: config?.phases ?? DEFAULT_JUNCTION_CONFIG.phases,
      timings: { ...DEFAULT_JUNCTION_CONFIG.timings, ...config?.timings },
      vehicleWeights: { ...DEFAULT_JUNCTION_CONFIG.vehicleWeights, ...config?.vehicleWeights },
    };
    if (!(await service.createJunction(id, name, merged))) {
      return res.status(409).json({ error: 'JUNCTION_EXISTS', message: `junction ${id} already exists` });
    }
    res.status(201).json({ id, name, config: merged });
  });

  router.get('/junctions/:id/status', (req, res) => {
    res.json(service.status(req.params.id));
  });

  router.get('/junctions/:id/history', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    res.json(service.history(req.params.id, limit));
  });

  router.post('/junctions/:id/commands', async (req, res) => {
    const parsed = commandSchema.safeParse(req.body);
    if (!parsed.success) return validationFailed(res, 400, parsed.error);

    const body = parsed.data;
    const decision = await service.sendCommand(
      req.params.id,
      body.command === 'MANUAL_GREEN_REQUEST'
        ? { type: 'MANUAL_GREEN_REQUEST', direction: body.direction, issuedBy: body.issued_by }
        : { type: 'RETURN_TO_AUTOMATIC', issuedBy: body.issued_by },
    );
    if (decision.error) return domainFailed(res, decision.error, 400);
    res.status(202).json({ accepted: true, status: service.status(req.params.id) });
  });

  router.post('/sensor-events', async (req, res) => {
    const parsed = sensorEventSchema.safeParse(req.body);
    if (!parsed.success) {
      if (typeof req.body?.junction_id === 'string') {
        service.auditRejectedEvent(req.body.junction_id, { eventId: req.body.event_id ?? null, issues: formatIssues(parsed.error) });
      }
      return validationFailed(res, 422, parsed.error);
    }

    const e = parsed.data;
    const sensorTime = Date.parse(e.timestamp);
    const result = await service.submitSensorEvent({
      eventId: e.event_id,
      junctionId: e.junction_id,
      rawTimestamp: e.timestamp,
      payload: e,
      input:
        e.event_type === 'VEHICLE_ARRIVED'
          ? { type: 'VEHICLE_ARRIVED', vehicleId: e.vehicle_id, direction: e.direction, vehicleType: e.vehicle_type, sequenceNo: e.sequence_no, sensorTime }
          : { type: 'VEHICLE_CLEARED', vehicleId: e.vehicle_id, direction: e.direction, sequenceNo: e.sequence_no, sensorTime },
    });

    switch (result.outcome) {
      case 'APPLIED':
        return res.status(201).json({ event_id: e.event_id, duplicate: false, queues: service.status(e.junction_id).queues });
      case 'DUPLICATE':
        return res.status(200).json({ event_id: e.event_id, duplicate: true });
      case 'ID_CONFLICT':
        return res.status(409).json({ error: 'EVENT_ID_CONFLICT', message: 'event_id was already used for a different payload' });
      case 'REJECTED':
        return domainFailed(res, result.decision.error!, 422);
    }
  });

  router.post('/controller-events', async (req, res) => {
    // The spec's example ACK has a single actual_state. One state can't confirm a whole junction,
    // so say clearly what we expect instead of returning a bare validation error.
    if (req.body?.actual_state !== undefined && req.body?.actual_signals === undefined) {
      return res.status(422).json({
        error: 'ACTUAL_SIGNALS_REQUIRED',
        message:
          'Commands cover the whole junction, so an ACK must report every signal. Send actual_signals instead of actual_state, ' +
          'e.g. {"command_id":"cmd-A-3","junction_id":"A","status":"ACK","actual_signals":{"NORTH":"GREEN","SOUTH":"GREEN","EAST":"RED","WEST":"RED"}}',
      });
    }
    const parsed = controllerEventSchema.safeParse(req.body);
    if (!parsed.success) return validationFailed(res, 422, parsed.error);

    const e = parsed.data;
    const decision = await service.controllerEvent(
      e.junction_id,
      e.status === 'ACK'
        ? { type: 'CONTROLLER_ACK', commandId: e.command_id, status: 'ACK', actualSignals: e.actual_signals }
        : { type: 'CONTROLLER_ACK', commandId: e.command_id, status: 'NACK', actualSignals: e.actual_signals },
    );
    const audits = decision.effects.flatMap((fx) => (fx.type === 'AUDIT' ? [fx.entry.eventType] : []));
    res.json({ command_id: e.command_id, result: audits, mode: decision.state.mode });
  });

  router.post('/device-status', async (req, res) => {
    const parsed = deviceStatusSchema.safeParse(req.body);
    if (!parsed.success) return validationFailed(res, 422, parsed.error);

    const e = parsed.data;
    const decision = await service.deviceStatus(
      e.junction_id,
      e.device_type === 'SENSOR'
        ? { type: 'SENSOR_STATUS', direction: e.direction, status: e.status }
        : { type: 'CONTROLLER_STATUS', status: e.status },
    );
    if (decision.error) return domainFailed(res, decision.error, 422);
    res.json({ accepted: true, mode: decision.state.mode });
  });

  router.get('/simulator', (_req, res) => {
    res.json({ auto_ack: simulator.settings.autoAck, ack_delay_ms: simulator.settings.ackDelayMs, sent: simulator.sent });
  });

  router.post('/simulator/settings', (req, res) => {
    const parsed = simulatorSettingsSchema.safeParse(req.body);
    if (!parsed.success) return validationFailed(res, 422, parsed.error);
    simulator.settings.autoAck = parsed.data.auto_ack ?? simulator.settings.autoAck;
    simulator.settings.ackDelayMs = parsed.data.ack_delay_ms ?? simulator.settings.ackDelayMs;
    res.json({ auto_ack: simulator.settings.autoAck, ack_delay_ms: simulator.settings.ackDelayMs });
  });

  router.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'no such endpoint' });
  });

  return router;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof NotFoundError) {
    return res.status(404).json({ error: 'NOT_FOUND', message: err.message });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'INVALID_JSON', message: 'request body is not valid JSON' });
  }
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'unexpected server error' });
};
