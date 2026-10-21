const { prisma, Prisma, withTransaction } = require('../config/database');
const v = require('../utils/validate');
const { resolveMissionId, assertAircraft } = require('./mission.service');

const MAX_RECORDS = 2000;

function normalizeRecord(r, i) {
  if (!r || typeof r !== 'object') throw v.bad(`records[${i}] must be an object`);
  const p = `records[${i}]`;
  const ts = v.dateField(r.timestamp, `${p}.timestamp`);
  if (new Date(ts).getTime() > Date.now() + 24 * 3600 * 1000) throw v.bad(`${p}.timestamp is more than a day in the future`);
  return {
    timestamp: new Date(ts),
    message_type: v.strField(r.message_type, `${p}.message_type`, { max: 60 }),
    latitude: v.numField(r.latitude, `${p}.latitude`, { min: -90, max: 90, nullable: true }),
    longitude: v.numField(r.longitude, `${p}.longitude`, { min: -180, max: 180, nullable: true }),
    altitude_m: v.numField(r.altitude_m, `${p}.altitude_m`, { min: -1000, max: 100000, nullable: true }),
    relative_altitude_m: v.numField(r.relative_altitude_m, `${p}.relative_altitude_m`, { min: -1000, max: 100000, nullable: true }),
    speed_mps: v.numField(r.speed_mps, `${p}.speed_mps`, { min: 0, max: 1000, nullable: true }),
    heading_deg: v.numField(r.heading_deg, `${p}.heading_deg`, { min: 0, max: 360, nullable: true }),
    battery_voltage: v.numField(r.battery_voltage, `${p}.battery_voltage`, { min: 0, max: 1000, nullable: true }),
    raw_data: v.objectField(r.raw_data, `${p}.raw_data`),
  };
}

async function ingest(body) {
  body = body || {};
  const aircraftId = v.bigintField(body.aircraft_id, 'aircraft_id');
  const batchId = v.uuidField(body.batch_id, 'batch_id');
  const flightId = v.uuidField(body.flight_id, 'flight_id', { nullable: true });
  const missionHash = v.sha256Field(body.mission_hash, 'mission_hash', { nullable: true });
  if (!Array.isArray(body.records) || body.records.length === 0) throw v.bad('records must be a non-empty array');
  if (body.records.length > MAX_RECORDS) throw v.bad(`records may not exceed ${MAX_RECORDS}`);
  const records = body.records.map(normalizeRecord);

  return withTransaction(async (tx) => {
    await assertAircraft(tx, aircraftId);
    const missionId = await resolveMissionId(tx, aircraftId, missionHash);
    // Idempotency: a batch_id that already exists means this is a retry; store nothing twice.
    const b = await tx.telemetryBatch.createMany({
      data: [{ batch_id: batchId, aircraft_id: aircraftId, mission_id: missionId, flight_id: flightId, record_count: records.length }],
      skipDuplicates: true,
    });
    if (b.count === 0) return { batch_id: batchId, duplicate: true, stored: 0 };
    await tx.telemetry.createMany({
      data: records.map((r) => ({
        ...r, aircraft_id: aircraftId, mission_id: missionId, flight_id: flightId, batch_id: batchId,
        raw_data: r.raw_data ?? Prisma.DbNull,
      })),
    });
    return { batch_id: batchId, duplicate: false, stored: records.length };
  });
}

async function query(q) {
  const aircraftId = v.bigintField(q.aircraft_id, 'aircraft_id', { nullable: true });
  const missionId = v.bigintField(q.mission_id, 'mission_id', { nullable: true });
  const flightId = v.uuidField(q.flight_id, 'flight_id', { nullable: true });
  const from = v.dateField(q.from, 'from', { nullable: true });
  const to = v.dateField(q.to, 'to', { nullable: true });
  const messageType = v.strField(q.message_type, 'message_type', { max: 60, nullable: true });
  const limit = Math.min(v.intField(q.limit, 'limit', { min: 1, max: 10000, nullable: true }) || 1000, 10000);
  const offset = v.intField(q.offset, 'offset', { min: 0, nullable: true }) || 0;

  const where = {};
  if (aircraftId !== null) where.aircraft_id = aircraftId;
  if (missionId !== null) where.mission_id = missionId;
  if (flightId !== null) where.flight_id = flightId;
  if (messageType !== null) where.message_type = messageType;
  if (from || to) where.timestamp = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };

  return prisma.telemetry.findMany({
    where, orderBy: [{ timestamp: 'asc' }, { id: 'asc' }], take: limit, skip: offset,
  });
}

module.exports = { ingest, query };
