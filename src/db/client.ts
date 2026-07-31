import "dotenv/config";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
export const db = drizzle({ client: pool });

export type Db = typeof db;

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
