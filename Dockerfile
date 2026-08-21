FROM node:22-bookworm-slim

# La sauvegarde/restauration (voir src/services/backupService.js) shell-out vers pg_dump/psql —
# absents d'une image Node standard. Le paquet postgresql-client de Debian bookworm est en
# version 15, potentiellement en retard sur le Postgres réellement utilisé par le projet
# Supabase (17 sur les projets récents) ; on installe donc depuis le dépôt officiel PostgreSQL
# pour rester aligné. postgresql-client-common (dépendance de postgresql-client-17) met en
# place les liens /usr/bin/pg_dump et /usr/bin/psql automatiquement.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg lsb-release \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && apt-get purge -y --auto-remove curl gnupg lsb-release \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copié et installé séparément du reste du code : le cache Docker ne réinvalide cette étape
# (la plus lente) que si les dépendances changent, pas à chaque modification de src/.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "src/index.js"]
