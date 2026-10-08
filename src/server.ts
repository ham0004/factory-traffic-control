import express from 'express';
import { openDatabase, seedJunction } from './infra/db';
import { DEFAULT_JUNCTION_CONFIG } from './domain/config';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? 'data/traffic.db';

const db = openDatabase(DB_PATH);
if (seedJunction(db, 'A', 'Junction A', DEFAULT_JUNCTION_CONFIG)) {
  console.log('seeded junction A');
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT} (db: ${DB_PATH})`);
});
