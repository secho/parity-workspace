/**
 * The only place this process reads its environment. Everything else takes config
 * as an argument, which is what makes the ingest testable against a second database.
 */

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`missing required env var ${name}`);
  return value;
}

export interface Config {
  port: number;
  pgUrl: string;
  mssql: {
    server: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 3000),
    pgUrl: required('PARITY_PG_URL', 'postgres://parity:parity@localhost:5433/parity'),
    mssql: {
      // Parity reaches ParityShop over the database connection and nothing else.
      // It never imports the demo app's code — that separation is the whole argument.
      server: required('MSSQL_HOST', 'localhost'),
      port: Number(process.env.MSSQL_PORT ?? 1433),
      database: required('MSSQL_DATABASE', 'ParityShop'),
      user: required('MSSQL_USER', 'sa'),
      password: required('MSSQL_SA_PASSWORD'),
    },
  };
}
