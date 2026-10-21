const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const env = require('../config/env');
const { prisma } = require('../config/database');
const { HttpError } = require('../middleware/error.middleware');
const v = require('../utils/validate');
const { resolveMissionId, assertAircraft } = require('./mission.service');

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let size = 0;
    fs.createReadStream(filePath)
      .on('data', (c) => { h.update(c); size += c.length; })
      .on('error', reject)
      .on('end', () => resolve({ sha256: h.digest('hex'), size }));
  });
}

async function safeUnlink(p) {
  if (!p) return;
  try { await fsp.unlink(p); } catch (e) { if (e.code !== 'ENOENT') console.error('unlink failed', p, e.message); }
}

/** Resolve a DB-stored relative path and guarantee it stays inside LOG_STORAGE_DIR. */
function resolveStoragePath(rel) {
  const abs = path.resolve(env.logStorageDir, rel);
  if (!abs.startsWith(env.logStorageDir + path.sep)) throw new HttpError(500, 'bad_storage_path', 'Stored path is invalid');
  return abs;
}

function safeName(name) {
  const base = path.basename(String(name || 'flight.bin')).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  return base || 'flight.bin';
}

/**
 * Store an already-received temp file (multer wrote it to LOG_STORAGE_DIR/.tmp).
 * Verifies size + SHA-256 against what the Jetson declared, then moves it into place.
 */
async function storeUploadedLog(file, body) {
  body = body || {};
  const aircraftId = v.bigintField(body.aircraft_id, 'aircraft_id');
  const claimedSha = v.sha256Field(body.checksum_sha256, 'checksum_sha256');
  const claimedSize = v.bigintField(body.file_size_bytes, 'file_size_bytes');
  const missionHash = v.sha256Field(body.mission_hash, 'mission_hash', { nullable: true });
  const flightId = v.uuidField(body.flight_id, 'flight_id', { nullable: true });
  const logNumber = v.intField(body.log_number, 'log_number', { min: 0, nullable: true });
  const filename = safeName(body.filename || file.originalname);
  if (!/\.bin$/i.test(filename)) throw new HttpError(415, 'unsupported_file_type', 'Only .bin flight logs are accepted');

  const { sha256, size } = await hashFile(file.path);
  if (BigInt(size) !== claimedSize || sha256 !== claimedSha) {
    throw new HttpError(422, 'integrity_mismatch', 'Received file does not match declared size/checksum', {
      declared: { size: Number(claimedSize), sha256: claimedSha }, received: { size, sha256 },
    });
  }

  await assertAircraft(prisma, aircraftId);
  const missionId = await resolveMissionId(prisma, aircraftId, missionHash);

  const rel = path.join(`aircraft-${aircraftId}`, `mission-${missionId ?? 'unassigned'}`, `${crypto.randomUUID()}_${filename}`);
  const abs = resolveStoragePath(rel);

  // Claim the row first (status 'transferring'). createMany+skipDuplicates is INSERT ... ON CONFLICT DO NOTHING.
  // If the row already exists and is not verified (an earlier attempt died), take it over; if it is verified,
  // this upload is a duplicate.
  const ins = await prisma.flightLog.createMany({
    data: [{ aircraft_id: aircraftId, mission_id: missionId, flight_id: flightId, log_number: logNumber, filename,
      storage_path: rel, file_size_bytes: BigInt(size), checksum_sha256: sha256, status: 'transferring' }],
    skipDuplicates: true,
  });
  let claimed = ins.count > 0;
  if (!claimed) {
    const takeover = await prisma.flightLog.updateMany({
      where: { aircraft_id: aircraftId, checksum_sha256: sha256, status: { not: 'verified' } },
      data: { status: 'transferring', storage_path: rel, filename,
        ...(missionId !== null ? { mission_id: missionId } : {}), ...(flightId ? { flight_id: flightId } : {}) },
    });
    claimed = takeover.count > 0;
  }
  const row = await prisma.flightLog.findFirst({ where: { aircraft_id: aircraftId, checksum_sha256: sha256 } });

  if (!claimed) {
    await safeUnlink(file.path);
    return { id: Number(row.id), status: 'verified', duplicate: true, file_size_bytes: Number(row.file_size_bytes), checksum_sha256: row.checksum_sha256 };
  }

  const id = row.id;
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.rename(file.path, abs); // same filesystem: atomic
    // Only finish if this request still owns the row. A concurrent upload of the same log may have taken it
    // over (different storage_path); in that case drop our copy and let the Jetson retry (then it is a duplicate).
    const done = await prisma.flightLog.updateMany({
      where: { id, storage_path: rel, status: 'transferring' },
      data: { status: 'verified', verified_at: new Date() },
    });
    if (!done.count) {
      await safeUnlink(abs);
      throw new HttpError(409, 'upload_conflict', 'Same log is being stored by another request; retry');
    }
  } catch (err) {
    await safeUnlink(abs);
    await prisma.flightLog.updateMany({ where: { id, storage_path: rel, status: 'transferring' }, data: { status: 'failed' } }).catch(() => {});
    throw err;
  }
  return { id: Number(id), status: 'verified', duplicate: false, file_size_bytes: size, checksum_sha256: sha256 };
}

async function listLogs(q) {
  const aircraftId = v.bigintField(q.aircraft_id, 'aircraft_id', { nullable: true });
  const missionId = v.bigintField(q.mission_id, 'mission_id', { nullable: true });
  const status = v.strField(q.status, 'status', { max: 30, nullable: true });
  const limit = Math.min(v.intField(q.limit, 'limit', { min: 1, max: 500, nullable: true }) || 100, 500);
  const offset = v.intField(q.offset, 'offset', { min: 0, nullable: true }) || 0;
  const where = {};
  if (aircraftId !== null) where.aircraft_id = aircraftId;
  if (missionId !== null) where.mission_id = missionId;
  if (status !== null) where.status = status;
  return prisma.flightLog.findMany({
    where,
    select: {
      id: true, aircraft_id: true, mission_id: true, flight_id: true, log_number: true, filename: true,
      file_size_bytes: true, checksum_sha256: true, status: true, created_at: true, verified_at: true,
    },
    orderBy: { id: 'desc' }, take: limit, skip: offset,
  });
}

async function getDownload(idRaw) {
  const id = v.bigintField(idRaw, 'id');
  const row = await prisma.flightLog.findUnique({ where: { id }, select: { id: true, filename: true, storage_path: true, status: true } });
  if (!row) throw new HttpError(404, 'log_not_found', `Log ${id} not found`);
  if (row.status !== 'verified') throw new HttpError(409, 'log_not_verified', 'Log is not verified yet');
  const abs = resolveStoragePath(row.storage_path);
  try { await fsp.access(abs, fs.constants.R_OK); } catch (_) { throw new HttpError(404, 'file_missing', 'Log file is missing on disk'); }
  return { abs, filename: row.filename };
}

module.exports = { storeUploadedLog, listLogs, getDownload, safeUnlink };
