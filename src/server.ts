import express from 'express';
import { RestSimulatorController } from './adapters/restSimulatorController';
import { JunctionService } from './app/junctionService';
import { startTicker } from './app/ticker';
import { DEFAULT_JUNCTION_CONFIG } from './domain/config';
import { openDatabase, seedJunction } from './infra/db';
import { Repository } from './infra/repository';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? 'data/traffic.db';

const db = openDatabase(DB_PATH);
if (seedJunction(db, 'A', 'Junction A', DEFAULT_JUNCTION_CONFIG)) {
  console.log('seeded junction A');
}

const controller = new RestSimulatorController();
const service = new JunctionService(new Repository(db), controller);
controller.setAckHandler((ack) => {
  service
    .controllerEvent(ack.junctionId, { type: 'CONTROLLER_ACK', ...ack })
    .catch((err) => console.error('simulated ACK failed:', err));
});

await service.recoverAll();
console.log(`recovery started for: ${service.junctionIds().join(', ')}`);
startTicker(service);

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ status: 'ok' });
});

app.get('/api/junctions/:id/status', (req, res) => {
  res.json(service.status(req.params.id));
});

app.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT} (db: ${DB_PATH})`);
});
