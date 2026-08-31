import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

function getOptimizedDatabaseUrl(): string | undefined {
  let url = process.env.DATABASE_URL;
  if (!url) return undefined;

  // Clean any problematic channel_binding param
  url = url.replace(/&channel_binding=[^&]*/g, "").replace(/\?channel_binding=[^&]*&?/g, "?");

  const hasParams = url.includes("?");
  const separator = hasParams ? "&" : "?";

  if (!url.includes("connection_limit=")) {
    url += `${separator}connection_limit=25`;
  }
  if (!url.includes("pool_timeout=")) {
    url += `&pool_timeout=30`;
  }
  if (!url.includes("connect_timeout=")) {
    url += `&connect_timeout=30`;
  }

  return url;
}

const databaseUrl = getOptimizedDatabaseUrl();

const prisma =
  global.prismaGlobal ??
  new PrismaClient({
    ...(databaseUrl ? { datasourceUrl: databaseUrl } : {}),
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (!global.prismaGlobal) {
  global.prismaGlobal = prisma;
}

export default prisma;
