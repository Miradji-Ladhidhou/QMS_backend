import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from './app.js';

// Durcissement : filet de sécurité global (voir app.js, fin du fichier) — toute erreur qui
// l'atteint doit renvoyer un message générique, jamais le détail brut (trace, message
// Postgres/Supabase/body-parser...). Le JSON malformé est le déclencheur le plus simple à
// provoquer sans dépendre d'une route particulière : express.json() lève une SyntaxError avec
// status 400 avant même d'atteindre un handler de route.
describe('Filet de sécurité global (app.js)', () => {
  it('un corps JSON malformé renvoie 400 avec un message générique, pas la trace du parseur', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .send('{ ceci n\'est pas du json');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Une erreur inattendue est survenue.');
    expect(JSON.stringify(res.body)).not.toMatch(/Unexpected token|at JSON.parse|node_modules/);
  });

  it('une route inexistante renvoie 404 sans détail interne', async () => {
    const res = await request(app).get('/api/route-qui-nexiste-pas');
    expect(res.status).toBe(404);
  });
});

// Régression réelle : Helmet interdit par défaut toute mise en cadre (frame-ancestors 'self'),
// ce qui bloquait silencieusement l'aperçu en ligne d'un document Google Drive
// (DocumentPreviewModal.jsx charge /api/documents/drive-file dans une <iframe> depuis
// l'origine DU FRONTEND, différente de ce backend) — voir app.js pour le correctif.
describe('En-tête frame-ancestors (app.js)', () => {
  it("autorise explicitement FRONTEND_URL à nous mettre en cadre, en plus de 'self'", async () => {
    const res = await request(app).get('/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("frame-ancestors 'self' " + process.env.FRONTEND_URL);
  });
});
