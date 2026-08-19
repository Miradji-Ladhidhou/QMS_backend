import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import authRoutes from './routes/auth.js';
import documentsRoutes from './routes/documents.js';
import categoriesRoutes from './routes/categories.js';
import capasRoutes from './routes/capas.js';
import qqoqccpRoutes from './routes/qqoqccp.js';
import auditsRoutes from './routes/audits.js';
import managementReviewsRoutes from './routes/managementReviews.js';
import complaintsRoutes from './routes/complaints.js';
import trainingsRoutes from './routes/trainings.js';
import kpisRoutes from './routes/kpis.js';
import kpiImportsRoutes from './routes/kpiImports.js';
import kpiFoldersRoutes from './routes/kpiFolders.js';
import usersRoutes from './routes/users.js';
import tenantRoutes from './routes/tenant.js';
import workflowsRoutes from './routes/workflows.js';
import notificationsRoutes from './routes/notifications.js';
import groupsRoutes from './routes/groups.js';
import servicesRoutes from './routes/services.js';
import employeesRoutes from './routes/employees.js';
import tasksRoutes from './routes/tasks.js';
import dashboardRoutes from './routes/dashboard.js';
import planningRoutes from './routes/planning.js';
import superAdminRoutes from './routes/superAdmin.js';

// Séparé de index.js pour être importable par les tests d'intégration (supertest) sans
// démarrer un vrai serveur HTTP ni le cron de notifications.
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
app.use('/api/qqoqccp', qqoqccpRoutes);
app.use('/api/audits', auditsRoutes);
app.use('/api/management-reviews', managementReviewsRoutes);
app.use('/api/complaints', complaintsRoutes);
app.use('/api/trainings', trainingsRoutes);
app.use('/api/kpis', kpisRoutes);
app.use('/api/kpi-imports', kpiImportsRoutes);
app.use('/api/kpi-folders', kpiFoldersRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/tenant', tenantRoutes);
app.use('/api/workflows', workflowsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/employees', employeesRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/planning', planningRoutes);
app.use('/api/super-admin', superAdminRoutes);

export default app;
