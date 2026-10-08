export type Direction = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST';
export const DIRECTIONS: readonly Direction[] = ['NORTH', 'SOUTH', 'EAST', 'WEST'];

export type SignalColor = 'RED' | 'YELLOW' | 'GREEN';
// What the controller reported. UNKNOWN until it confirms something (and again after a restart).
export type ObservedColor = SignalColor | 'UNKNOWN';
export type Signals = Record<Direction, SignalColor>;
export type ObservedSignals = Record<Direction, ObservedColor>;

export type VehicleType = 'EMPLOYEE_VEHICLE' | 'FORKLIFT' | 'TRUCK' | 'EMERGENCY';
export const VEHICLE_TYPES: readonly VehicleType[] = ['EMPLOYEE_VEHICLE', 'FORKLIFT', 'TRUCK', 'EMERGENCY'];

export type Mode = 'AUTOMATIC' | 'MANUAL' | 'EMERGENCY' | 'DEGRADED';
export type DeviceStatus = 'ONLINE' | 'OFFLINE' | 'UNKNOWN';

// Phase ids come from junction config (e.g. NORTH_SOUTH), so they are plain strings.
export type PhaseId = string;

export type Stage =
  | { kind: 'GREEN'; phase: PhaseId; enteredAt: number }
  | { kind: 'YELLOW'; phase: PhaseId; nextPhase: PhaseId; enteredAt: number }
  | { kind: 'ALL_RED'; nextPhase: PhaseId; enteredAt: number };

export type VehicleStatus = 'WAITING' | 'CLEARED' | 'TOMBSTONE';

export interface Vehicle {
  vehicleId: string;
  direction: Direction;
  vehicleType: VehicleType | null;
  status: VehicleStatus;
  arrivedAt: number | null;
  clearedAt: number | null;
  lastSequenceNo: number | null;
}

export interface EmergencyRequest {
  vehicleId: string;
  direction: Direction;
  detectedAt: number;
}

export interface ManualOverride {
  phase: PhaseId;
  direction: Direction;
  expiresAt: number;
  issuedBy: string | null;
}

export interface PendingCommand {
  commandId: string;
  desiredSignals: Signals;
  sentAt: number;
  attempts: number;
}

export interface JunctionState {
  junctionId: string;
  mode: Mode;
  stage: Stage;
  lastGreenPhase: PhaseId;
  // When each phase last had green (its start while green, its end once it went yellow).
  phaseServedAt: Record<PhaseId, number>;
  controllerStatus: DeviceStatus;
  sensorStatus: Record<Direction, DeviceStatus>;
  actualSignals: ObservedSignals;
  pendingCommand: PendingCommand | null;
  commandCounter: number;
  degradedReason: string | null;
  emergencies: EmergencyRequest[];
  manual: ManualOverride | null;
  lastSequenceNo: number | null;
  vehicles: Record<string, Vehicle>;
}

export interface JunctionConfig {
  phases: Record<PhaseId, Direction[]>;
  timings: {
    minGreenMs: number;
    normalGreenMs: number;
    maxGreenMs: number;
    yellowMs: number;
    allRedMs: number;
    ackTimeoutMs: number;
    degradedResendMs: number;
  };
  vehicleWeights: Record<VehicleType, number>;
  waitWeightPerSecond: number;
  switchHysteresis: number;
  starvationMs: number;
  emergencyTimeoutMs: number;
  staleEventMs: number;
  futureToleranceMs: number;
  manualTtlMs: number;
  maxCommandAttempts: number;
}

export type Input =
  | {
      type: 'VEHICLE_ARRIVED';
      vehicleId: string;
      direction: Direction;
      vehicleType: VehicleType;
      sequenceNo: number;
      sensorTime: number;
    }
  | { type: 'VEHICLE_CLEARED'; vehicleId: string; direction: Direction; sequenceNo: number; sensorTime: number }
  | { type: 'MANUAL_GREEN_REQUEST'; direction: Direction; issuedBy?: string }
  | { type: 'RETURN_TO_AUTOMATIC'; issuedBy?: string }
  | { type: 'CONTROLLER_ACK'; commandId: string; status: 'ACK'; actualSignals: ObservedSignals }
  | { type: 'CONTROLLER_ACK'; commandId: string; status: 'NACK'; actualSignals?: ObservedSignals }
  | { type: 'CONTROLLER_STATUS'; status: 'ONLINE' | 'OFFLINE' }
  | { type: 'SENSOR_STATUS'; direction: Direction; status: 'ONLINE' | 'OFFLINE' }
  | { type: 'TICK' }
  | { type: 'RECOVER' };

export interface ControllerCommand {
  commandId: string;
  junctionId: string;
  desiredSignals: Signals;
}

export interface AuditEntry {
  eventType: string;
  direction?: Direction;
  previousState?: string;
  newState?: string;
  commandId?: string;
  details?: Record<string, unknown>;
}

export type CommandResult = 'ACKED' | 'FAILED' | 'TIMEOUT' | 'STALE';

export type Effect =
  | { type: 'AUDIT'; entry: AuditEntry }
  | { type: 'SEND_COMMAND'; command: ControllerCommand; attempt: number }
  | { type: 'COMMAND_RESULT'; commandId: string; result: CommandResult; actualSignals?: ObservedSignals };

export interface DomainError {
  kind: 'INVALID' | 'CONFLICT';
  code: string;
  message: string;
}

export interface Decision {
  state: JunctionState;
  effects: Effect[];
  error?: DomainError;
}
