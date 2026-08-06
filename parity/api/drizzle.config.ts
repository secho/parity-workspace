import type { Config } from 'drizzle-kit';

/** Migrations are generated with `npm run generate` and committed. The API applies
 *  them on boot, so a fresh `docker compose up` needs no migration step of its own. */
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.PARITY_PG_URL ?? 'postgres://parity:parity@localhost:5433/parity',
  },
} satisfies Config;
