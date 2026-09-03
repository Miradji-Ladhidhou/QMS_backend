// Doit être importé avant toute déclaration de route : patche Express pour qu'un rejet dans
// un handler `async (req, res) => {...}` (la quasi-totalité des routes de ce projet) atterrisse
// automatiquement sur le error handler global ci-dessous, au lieu de rester une promesse
// rejetée non gérée qui laisse la requête pendre indéfiniment sans réponse (piège classique
// d'Express 4 — corrigé nativement dans Express 5, mais ce projet est encore en 4).
import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { authLimiter, apiLimiter } from './middleware/rateLimit.js';
import authRoutes from './routes/auth.js';
import documentsRoutes from './routes/documents.js';
import sharesRoutes from './routes/shares.js';
import categoriesRoutes from './routes/categories.js';
import moduleCategoriesRoutes from './routes/moduleCategories.js';
import capasRoutes from './routes/capas.js';
import qqoqccpRoutes from './routes/qqoqccp.js';
import auditsRoutes from './routes/audits.js';
import managementReviewsRoutes from './routes/managementReviews.js';
import complaintsRoutes from './routes/complaints.js';
import risksRoutes from './routes/risks.js';
import haccpRoutes from './routes/haccp.js';
import suppliersRoutes from './routes/suppliers.js';
import aiRoutes from './routes/ai.js';
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
import reportsRoutes from './routes/reports.js';
import driveIntegrationRoutes from './routes/driveIntegration.js';
import proceduresRoutes from './routes/procedures.js';
import procedureTemplatesRoutes from './routes/procedureTemplates.js';

// Échoue au démarrage plutôt qu'en silence — même principe que services/supabase.js pour
// SUPABASE_URL/SUPABASE_SERVICE_KEY. Sans ça, un FRONTEND_URL absent en production ferait
// passer `cors({ origin: undefined })` en mode permissif (reflète l'Origin de la requête),
// bien pire qu'un crash immédiat et explicite au boot.
if (!process.env.FRONTEND_URL) {
  throw new Error('Missing FRONTEND_URL environment variable.');
}

// Séparé de index.js pour être importable par les tests d'intégration (supertest) sans
// démarrer un vrai serveur HTTP ni le cron de notifications.
const app = express();

// Nécessaire pour que req.ip reflète l'IP réelle du client derrière un reverse proxy
// (Render, etc.) plutôt que celle du proxy — utilisé pour la signature électronique et le
// rate limiting ci-dessous (express-rate-limit s'appuie sur req.ip). `true` fait confiance à
// TOUTE la chaîne X-Forwarded-For fournie par le client, ce qui permet de usurper une IP et de
// contourner le rate limiting (ERR_ERL_PERMISSIVE_TRUST_PROXY) — `1` ne fait confiance qu'au
// premier hop (le proxy Render lui-même), ce qui suffit puisqu'il n'y a qu'un seul proxy devant
// l'app.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(apiLimiter);
// Limite par défaut (100kb) trop juste pour POST /api/reports/table-pdf : un export de
// plusieurs centaines d'enregistrements formatés dépasse vite ce seuil.
app.use(express.json({ limit: '5mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/shares', sharesRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/module-categories', moduleCategoriesRoutes);
app.use('/api/capas', capasRoutes);
app.use('/api/qqoqccp', qqoqccpRoutes);
app.use('/api/audits', auditsRoutes);
app.use('/api/management-reviews', managementReviewsRoutes);
app.use('/api/complaints', complaintsRoutes);
app.use('/api/risks', risksRoutes);
app.use('/api/haccp', haccpRoutes);
app.use('/api/suppliers', suppliersRoutes);
app.use('/api/ai', aiRoutes);
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
app.use('/api/reports', reportsRoutes);
app.use('/api/drive', driveIntegrationRoutes);
app.use('/api/procedures', proceduresRoutes);
app.use('/api/procedure-templates', procedureTemplatesRoutes);

// Filet de sécurité final : toute erreur qui atteint ce point (throw synchrone, rejet async
// grâce à express-async-errors ci-dessus, ou next(err) explicite) est loguée côté serveur
// avec sa trace complète, mais jamais renvoyée telle quelle au client — voir l'audit qui avait
// repéré plusieurs routes renvoyant err.message brut (ai.js, qqoqccp.js, notifications.js,
// trainings.js), potentiellement des détails internes (schéma DB, message Supabase/Groq).
// Express reconnaît ce middleware à sa signature à 4 paramètres, quel que soit son nom.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`Erreur non gérée sur ${req.method} ${req.originalUrl} :`, err);

  if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Fichier ou requête trop volumineux.' });
  }
  if (err.name === 'MulterError') {
    return res.status(400).json({ error: 'Fichier invalide.' });
  }

  res.status(err.status || err.statusCode || 500).json({ error: 'Une erreur inattendue est survenue.' });
});

export default app;
