const { prisma, Prisma, withTransaction } = require('../config/database');
const { HttpError } = require('../middleware/error.middleware');
const v = require('../utils/validate');

const STATUSES = ['received', 'in_progress', 'completed', 'ended_incomplete'];
const MAX_ITEMS = 5000;

/** `db` is either the prisma client or a transaction client. */
async function assertAircraft(db, aircraftId) {
  const a = await db.aircraft.findUnique({ where: { id: aircraftId }, select: { id: true } });
  if (!a) throw new HttpError(404, 'aircraft_not_found', `Aircraft ${aircraftId} does not exist`);
}

/** Resolve (aircraft, mission_hash) -> mission id. 409 means "not stored yet" so the Jetson retries later. */
async function resolveMissionId(db, aircraftId, missionHash) {
  if (!missionHash) return null;
  const m = await db.mission.findFirst({ where: { aircraft_id: aircraftId, mission_hash: missionHash }, select: { id: true } });
  if (!m) {
    throw new HttpError(409, 'mission_not_found', 'Mission for this hash has not been stored yet; retry after the mission upload');
  }
  return m.id;
}

function normalizeItem(raw, i) {
  if (!raw || typeof raw !== 'object') throw v.bad(`items[${i}] must be an object`);
  const p = `items[${i}]`;
  return {
    sequence_number: v.intField(raw.sequence_number, `${p}.sequence_number`, { min: 0, max: 65535 }),
    command: v.intField(raw.command, `${p}.command`, { min: 0, max: 65535 }),
    frame: v.intField(raw.frame, `${p}.frame`, { min: 0, max: 255, nullable: true }),
    param1: v.numField(raw.param1, `${p}.param1`, { nullable: true }),
    param2: v.numField(raw.param2, `${p}.param2`, { nullable: true }),
    param3: v.numField(raw.param3, `${p}.param3`, { nullable: true }),
    param4: v.numField(raw.param4, `${p}.param4`, { nullable: true }),
    latitude: v.numField(raw.latitude, `${p}.latitude`, { min: -90, max: 90, nullable: true }),
    longitude: v.numField(raw.longitude, `${p}.longitude`, { min: -180, max: 180, nullable: true }),
    altitude: v.numField(raw.altitude, `${p}.altitude`, { nullable: true }),
    autocontinue: v.boolField(raw.autocontinue, `${p}.autocontinue`),
    raw_item: v.objectField(raw.raw_item, `${p}.raw_item`),
  };
}

async function createMission(body) {
  body = body || {};
  const aircraftId = v.bigintField(body.aircraft_id, 'aircraft_id');
  const missionHash = v.sha256Field(body.mission_hash, 'mission_hash');
  const missionName = v.strField(body.mission_name, 'mission_name', { max: 150, nullable: true }) || `Mission ${missionHash.slice(0, 8)}`;
  if (!Array.isArray(body.items) || body.items.length === 0) throw v.bad('items must be a non-empty array');
  if (body.items.length > MAX_ITEMS) throw v.bad(`items may not exceed ${MAX_ITEMS}`);

  const items = body.items.map(normalizeItem);
  const seqs = items.map((i) => i.sequence_number).sort((a, b) => a - b);
  for (let k = 0; k < seqs.length; k += 1) {
    if (seqs[k] !== k) throw v.bad('sequence_number values must be unique and contiguous starting at 0');
  }

  // All-or-nothing: any failure rolls back and leaves no partial mission.
  return withTransaction(async (tx) => {
    await assertAircraft(tx, aircraftId);
    // createMany + skipDuplicates = INSERT ... ON CONFLICT DO NOTHING (safe under concurrent identical requests).
    const ins = await tx.mission.createMany({
      data: [{ aircraft_id: aircraftId, mission_name: missionName, mission_hash: missionHash, item_count: items.length }],
      skipDuplicates: true,
    });
    const mission = await tx.mission.findFirst({ where: { aircraft_id: aircraftId, mission_hash: missionHash }, select: { id: true, status: true } });
    if (ins.count === 0) {
      return { id: Number(mission.id), status: mission.status, duplicate: true, item_count: items.length };
    }
    await tx.waypoint.createMany({
      data: items.map((it) => ({ ...it, mission_id: mission.id, raw_item: it.raw_item ?? Prisma.DbNull })),
    });
    return { id: Number(mission.id), status: 'received', duplicate: false, item_count: items.length };
  });
}

async function listMissions(query) {
  const limit = Math.min(v.intField(query.limit, 'limit', { min: 1, max: 500, nullable: true }) || 100, 500);
  const offset = v.intField(query.offset, 'offset', { min: 0, nullable: true }) || 0;
  const aircraftId = v.bigintField(query.aircraft_id, 'aircraft_id', { nullable: true });
  return prisma.mission.findMany({
    where: aircraftId === null ? {} : { aircraft_id: aircraftId },
    select: {
      id: true, aircraft_id: true, mission_name: true, status: true, mission_hash: true, item_count: true,
      created_at: true, started_at: true, completed_at: true,
    },
    orderBy: { id: 'desc' },
    take: limit,
    skip: offset,
  });
}

async function getMission(idRaw) {
  const id = v.bigintField(idRaw, 'id');
  const m = await prisma.mission.findUnique({ where: { id } });
  if (!m) throw new HttpError(404, 'mission_not_found', `Mission ${id} not found`);
  const items = await prisma.waypoint.findMany({ where: { mission_id: id }, orderBy: { sequence_number: 'asc' } });
  return { ...m, items };
}

/** Idempotent, order-safe status update: an older event never overwrites a newer one. */
async function updateStatus(body) {
  body = body || {};
  const aircraftId = v.bigintField(body.aircraft_id, 'aircraft_id');
  const missionHash = v.sha256Field(body.mission_hash, 'mission_hash');
  const status = body.status;
  if (!STATUSES.includes(status)) throw v.bad(`status must be one of ${STATUSES.join(', ')}`);
  const eventTime = new Date(v.dateField(body.event_time, 'event_time'));
  const startedAt = v.dateField(body.started_at, 'started_at', { nullable: true });
  const completedAt = v.dateField(body.completed_at, 'completed_at', { nullable: true });

  return withTransaction(async (tx) => {
    const missionId = await resolveMissionId(tx, aircraftId, missionHash);
    // started_at / completed_at are always recorded; the status itself only moves forward in event time,
    // so queued events that arrive late or out of order can never overwrite a newer status.
    const times = {};
    if (startedAt) times.started_at = new Date(startedAt);
    if (completedAt) times.completed_at = new Date(completedAt);
    if (Object.keys(times).length) await tx.mission.updateMany({ where: { id: missionId }, data: times });
    const r = await tx.mission.updateMany({
      where: { id: missionId, OR: [{ status_at: null }, { status_at: { lte: eventTime } }] },
      data: { status, status_at: eventTime },
    });
    const now = await tx.mission.findUnique({ where: { id: missionId }, select: { status: true } });
    return { id: missionId, applied: r.count > 0, status: now.status };
  });
}

module.exports = { createMission, listMissions, getMission, updateStatus, resolveMissionId, assertAircraft };
