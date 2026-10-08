import type { ControllerCommand, ObservedSignals } from '../domain/types';
import type { ControllerPort } from '../ports/controllerPort';

export interface SimulatedAck {
  commandId: string;
  junctionId: string;
  status: 'ACK';
  actualSignals: ObservedSignals;
}

export interface SimulatorSettings {
  autoAck: boolean;
  ackDelayMs: number;
}

// Stands in for the physical controllers. With auto-ACK on it confirms every command after a delay,
// which is enough to watch the junction cycle. Turn it off to demo timeouts and manual ACK/NACK.
export class RestSimulatorController implements ControllerPort {
  settings: SimulatorSettings = { autoAck: true, ackDelayMs: 300 };
  readonly sent: (ControllerCommand & { sentAt: string })[] = [];
  private onAck: (ack: SimulatedAck) => void = () => {};

  setAckHandler(handler: (ack: SimulatedAck) => void) {
    this.onAck = handler;
  }

  send(command: ControllerCommand): void {
    this.sent.unshift({ ...command, sentAt: new Date().toISOString() });
    this.sent.length = Math.min(this.sent.length, 50);

    if (!this.settings.autoAck) return;
    setTimeout(() => {
      this.onAck({
        commandId: command.commandId,
        junctionId: command.junctionId,
        status: 'ACK',
        actualSignals: command.desiredSignals,
      });
    }, this.settings.ackDelayMs);
  }
}
