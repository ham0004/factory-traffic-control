import express from 'express';
import { RestSimulatorController } from './adapters/restSimulatorController';
import { JunctionService } from './app/junctionService';
import { startTicker } from './app/ticker';
import { DEFAULT_JUNCTION_CONFIG } from './domain/config';
import { createRouter, errorHandler } from './http/routes';
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

// One line per request. Dashboard polling (successful GETs) is skipped to keep the log readable.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.method === 'GET' && res.statusCode < 400) return;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
  });
  next();
});

app.use(express.static('public'));

app.get('/health', (_req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ status: 'ok' });
});

app.use('/api', createRouter(service, controller));
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT} (db: ${DB_PATH})`);
});
