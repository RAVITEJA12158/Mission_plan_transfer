import "dotenv/config";
import { defineConfig } from "prisma/config";

// Used by the Prisma CLI (generate, studio, db pull). The running app connects via the pg driver adapter.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
