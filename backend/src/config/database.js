const { PrismaClient, Prisma } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const env = require('./env');

// Prisma returns BIGINT columns (ids, file sizes) as BigInt, which JSON.stringify cannot serialise.
// All values here fit comfortably in a JS number, so serialise them as numbers.
// eslint-disable-next-line no-extend-native
BigInt.prototype.toJSON = function toJSON() { return Number(this); };

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.databaseUrl, max: 10 }) });

// Interactive transactions: generous timeout for large mission / telemetry inserts.
const TX_OPTIONS = { maxWait: 10000, timeout: 30000 };
const withTransaction = (fn) => prisma.$transaction(fn, TX_OPTIONS);

module.exports = { prisma, Prisma, withTransaction };
