import type { Context } from "hono";

import { drizzle } from "drizzle-orm/d1";

import type { AppEnv } from "../http/app-env";
import * as schema from "./schema";

export const createDatabase = (database: D1Database) =>
  drizzle(database, { schema });

export type Database = ReturnType<typeof createDatabase>;

export const dbFromContext = (context: Context<AppEnv>): Database =>
  createDatabase(context.env.KLEIS_DB);
