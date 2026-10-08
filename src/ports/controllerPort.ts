import type { ControllerCommand } from '../domain/types';

// How the backend talks to a physical junction controller. The REST simulator implements it today;
// an MQTT adapter would implement the same interface without touching the engine.
// send() is fire-and-forget: the answer comes back later as an ACK through JunctionService.
export interface ControllerPort {
  send(command: ControllerCommand): void;
}
