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
import kpiImportsRoutes from './routes/kpiImports.js';
import kpiFoldersRoutes from './routes/kpiFolders.js';
import usersRoutes from './routes/users.js';
import tenantRoutes from './routes/tenant.js';
import workflowsRoutes from './routes/workflows.js';
import notificationsRoutes from './routes/notifications.js';
import groupsRoutes from './routes/groups.js';
import { scheduleNotificationJob } from './jobs/notificationJob.js';

const app = express();

// Nécessaire pour que req.ip reflète l'IP réelle du client derrière un reverse proxy
// (Render, etc.) plutôt que celle du proxy — utilisé pour la signature électronique.
app.set('trust proxy', true);

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
app.use('/api/kpi-imports', kpiImportsRoutes);
app.use('/api/kpi-folders', kpiFoldersRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/tenant', tenantRoutes);
app.use('/api/workflows', workflowsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/groups', groupsRoutes);

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`QMS SaaS backend listening on port ${PORT}`);
});

scheduleNotificationJob();
