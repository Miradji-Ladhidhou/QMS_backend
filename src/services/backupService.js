import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const backupsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'backups');
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS) || 7;

function ensureBackupDirectory() {
  fs.mkdirSync(backupsDir, { recursive: true });
}

function buildBackupFilename() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `qms_backup_${stamp}.sql`;
}

function getBinaryCandidates(envVar, names) {
  const candidates = [
    process.env[envVar],
    ...['/Applications/Postgres.app/Contents/Versions/latest/bin', '/opt/homebrew/bin', '/usr/local/bin'].flatMap(
      (dir) => names.map((name) => path.join(dir, name))
    ),
    ...names,
  ].filter(Boolean);

  return [...new Set(candidates)].filter((binPath) => names.includes(binPath) || fs.existsSync(binPath));
}

function parseDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    const err = new Error('DATABASE_URL est manquante.');
    err.statusCode = 500;
    throw err;
  }

  const parsedUrl = new URL(databaseUrl);
  const database = parsedUrl.pathname.replace(/^\//, '');
  const username = decodeURIComponent(parsedUrl.username || '');
  const password = decodeURIComponent(parsedUrl.password || '');
  const host = parsedUrl.hostname;
  const port = parsedUrl.port || '5432';
  const sslMode = parsedUrl.searchParams.get('sslmode');

  if (!database || !username || !host) {
    throw new Error('DATABASE_URL invalide.');
  }

  const childEnv = { ...process.env, PGPASSWORD: password };
  if (sslMode) childEnv.PGSSLMODE = sslMode;

  return { database, username, host, port, childEnv };
}

// Ne sauvegarde/restaure que le schéma "public" (les tables applicatives, voir schema.sql) —
// jamais auth/storage/realtime, gérés par Supabase lui-même. Un pg_dump/restore de la base
// entière toucherait ces schémas internes (sessions actives, métadonnées de fichiers dont le
// contenu binaire n'est de toute façon pas dans Postgres) et risquerait de casser la stack
// Supabase, en local comme en hébergé.
async function runDatabaseBackup() {
  const { database, username, host, port, childEnv } = parseDatabaseUrl();
  ensureBackupDirectory();

  const filename = buildBackupFilename();
  const filePath = path.join(backupsDir, filename);

  const args = [
    '--schema=public',
    '--format=plain',
    '--no-owner',
    '--no-privileges',
    '--clean',
    '--if-exists',
    '--host', host,
    '--port', String(port),
    '--username', username,
    '--dbname', database,
    '--file', filePath,
  ];

  const candidates = getBinaryCandidates('PG_DUMP_BIN', ['pg_dump']);
  let lastError = null;

  for (const bin of candidates) {
    try {
      await execFileAsync(bin, args, { env: childEnv });
      lastError = null;
      break;
    } catch (execError) {
      lastError = execError;
    }
  }

  if (lastError) {
    const detail = (lastError.stderr || lastError.message || '').toString().trim();
    const err = new Error(`Échec de la sauvegarde : ${detail || 'Erreur inconnue.'}`);
    err.statusCode = 500;
    throw err;
  }

  const stats = fs.statSync(filePath);
  return { filename, filePath, sizeBytes: stats.size, createdAt: new Date().toISOString() };
}

// Les event triggers PostgREST (pgrst_drop_watch...) créés par Supabase appartiennent à un
// rôle superuser que l'app n'a pas forcément — psql échoue dessus sinon (constaté en pratique
// sur une stack sœur utilisant le même moteur Supabase local).
function stripEventTriggers(content) {
  const lines = content.split('\n');
  const result = [];
  let skip = false;

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (
      upper.startsWith('DROP EVENT TRIGGER') ||
      upper.startsWith('CREATE EVENT TRIGGER') ||
      upper.startsWith('ALTER EVENT TRIGGER')
    ) {
      skip = true;
    }
    if (!skip) result.push(line);
    if (skip && upper.includes(';')) skip = false;
  }

  return result.join('\n');
}

async function restoreFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    const err = new Error('Fichier de sauvegarde introuvable.');
    err.statusCode = 404;
    throw err;
  }

  const { database, username, host, port, childEnv } = parseDatabaseUrl();

  const strippedPath = `${filePath}.stripped.sql`;
  fs.writeFileSync(strippedPath, stripEventTriggers(fs.readFileSync(filePath, 'utf8')));

  const args = [
    '--host', host,
    '--port', String(port),
    '--username', username,
    '--dbname', database,
    '--file', strippedPath,
  ];

  const candidates = getBinaryCandidates('PSQL_BIN', ['psql']);
  let lastError = null;

  try {
    for (const bin of candidates) {
      try {
        await execFileAsync(bin, args, { env: childEnv });
        lastError = null;
        break;
      } catch (execError) {
        // Un psql qui échoue partiellement sur des objets dont l'app n'est pas propriétaire
        // (extensions, rôles Supabase) n'est pas un vrai échec de restauration tant que les
        // erreurs se limitent à ces cas attendus.
        const stderr = (execError.stderr || execError.message || '').toString();
        const errorLines = stderr.split('\n').filter((line) => /^psql:.*ERROR:/i.test(line));
        const onlyBenign =
          errorLines.length > 0 &&
          errorLines.every(
            (line) =>
              line.includes('must be owner of') || line.includes('already exists') || line.includes('does not exist')
          );
        lastError = onlyBenign ? null : execError;
        if (!lastError) break;
      }
    }
  } finally {
    try {
      fs.unlinkSync(strippedPath);
    } catch {
      // fichier temporaire déjà absent
    }
  }

  if (lastError) {
    const detail = (lastError.stderr || lastError.message || '').toString().trim();
    const err = new Error(`Échec de la restauration : ${detail || 'Erreur inconnue.'}`);
    err.statusCode = 500;
    throw err;
  }

  return reconcileUsersAuthLink({ database, username, host, port, childEnv });
}

// pg_dump --schema=public ne peut pas capturer users_id_fkey (elle référence auth.users, hors
// périmètre du dump) : --clean droppe la table public.users avant de la recréer, ce qui perd
// cette contrainte silencieusement à chaque restauration si on ne la recrée pas nous-mêmes.
// Une sauvegarde peut contenir des profils dont le compte de connexion a été supprimé
// définitivement depuis (l'inverse n'est pas censé arriver : voir routes/superAdmin.js, qui ne
// supprime plus jamais auth.users) — ces lignes ne peuvent plus jamais fonctionner, donc on les
// retire silencieusement plutôt que de faire échouer toute la restauration à cause d'elles.
async function reconcileUsersAuthLink({ database, username, host, port, childEnv }) {
  const sql = `
    DELETE FROM public.users u WHERE NOT EXISTS (SELECT 1 FROM auth.users au WHERE au.id = u.id);
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_id_fkey' AND conrelid = 'public.users'::regclass
      ) THEN
        ALTER TABLE public.users ADD CONSTRAINT users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `;

  const args = ['--host', host, '--port', String(port), '--username', username, '--dbname', database, '-v', 'ON_ERROR_STOP=1', '-c', sql];

  const candidates = getBinaryCandidates('PSQL_BIN', ['psql']);
  let lastError = null;

  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(bin, args, { env: childEnv });
      const match = stdout.match(/^DELETE (\d+)/m);
      return { orphanedProfilesRemoved: match ? Number(match[1]) : 0 };
    } catch (execError) {
      lastError = execError;
    }
  }

  const detail = (lastError?.stderr || lastError?.message || '').toString().trim();
  const err = new Error(
    `Restauration effectuée mais le lien entre les profils et les comptes de connexion n'a pas pu être rétabli : ${
      detail || 'erreur inconnue'
    }.`
  );
  err.statusCode = 500;
  throw err;
}

function getBackupPathByFilename(filename) {
  const safeName = path.basename(filename || '');
  if (!safeName || safeName !== filename) return null;
  return path.join(backupsDir, safeName);
}

function cleanupOldBackups(retentionDays = RETENTION_DAYS) {
  ensureBackupDirectory();
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(backupsDir).filter((file) => file.endsWith('.sql'));
  const deleted = [];

  for (const file of files) {
    const filePath = path.join(backupsDir, file);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoffMs) {
        fs.unlinkSync(filePath);
        deleted.push(file);
      }
    } catch {
      // fichier déjà supprimé entre le readdir et le stat
    }
  }

  return { deleted, kept: files.length - deleted.length };
}

export { backupsDir, runDatabaseBackup, restoreFromFile, getBackupPathByFilename, cleanupOldBackups };
