import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant } from '../test-utils/tenant.js';

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

// Durcissement : le logo était accepté quel que soit son type MIME et stocké tel quel comme
// content-type public — un SVG (peut embarquer du <script>) ou un HTML uploadé comme "logo"
// s'exécuterait dans le navigateur au lieu de s'afficher comme une image. Voir ALLOWED_LOGO_TYPES
// dans routes/tenant.js.
describe('POST /api/tenant/logo — types de fichiers acceptés', () => {
  it('accepte une image PNG, rejette un SVG', async () => {
    tenant = await createTenant();
    const fakeImage = Buffer.from('not a real image, content is irrelevant for this check');

    const svgAttempt = await request(app)
      .post('/api/tenant/logo')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', fakeImage, { filename: 'logo.svg', contentType: 'image/svg+xml' });
    expect(svgAttempt.status).toBe(400);

    const pngAttempt = await request(app)
      .post('/api/tenant/logo')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .attach('file', fakeImage, { filename: 'logo.png', contentType: 'image/png' });
    expect(pngAttempt.status).toBe(200);
    expect(pngAttempt.body.logo_url).toBeTruthy();
  });
});
