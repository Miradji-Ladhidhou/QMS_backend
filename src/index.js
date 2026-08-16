import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import authRoutes from './routes/auth.js';
import documentsRoutes from './routes/documents.js';
import categoriesRoutes from './routes/categories.js';
import capasRoutes from './routes/capas.js';
import trainingsRoutes from './routes/trainings.js';
import kpisRoutes from './routes/kpis.js';

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/capas', capasRoutes);
app.use('/api/trainings', trainingsRoutes);
app.use('/api/kpis', kpisRoutes);

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`QMS SaaS backend listening on port ${PORT}`);
});
