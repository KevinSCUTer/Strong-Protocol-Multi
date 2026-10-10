// Owner-configured BP music stays outside public/assets and the downloadable game-asset packs.
// Snapshot a sorted directory at boot; selecting a track never consumes the match's gameplay RNG.
import fsp from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const BP_MUSIC_PREFIX = '/api/bp-music/';
const TRACK_ID = /^[a-f0-9]{64}$/;

/** Only top-level, readable, nonempty MP3 files enter the zero-based, filename-sorted playlist. */
export async function createBpMusic({ folder = process.env.MP3_FOLDER, log = {} } = {}) {
  const tracks = new Map();
  let root = null;
  if (folder) {
    try {
      if (!path.isAbsolute(folder)) throw new Error('MP3_FOLDER must be an absolute path');
      root = await fsp.realpath(folder);
      const entries = await fsp.readdir(root, { withFileTypes: true });
      const names = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.') && /\.mp3$/i.test(entry.name))
        .map((entry) => entry.name).sort();
      for (const name of names) {
        try {
          const file = path.join(root, name);
          const stat = await fsp.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) continue;
          await fsp.access(file, constants.R_OK);
          const id = createHash('sha256').update(`${name}\0${stat.size}\0${stat.mtimeMs}`).digest('hex');
          tracks.set(id, { file, name });
        } catch { /* A vanished or unreadable entry is not a playable track. */ }
      }
      log.info?.(`[bp-music] ${tracks.size} MP3 file(s); empty playlists use the default BP music`);
    } catch (error) {
      log.warn?.(`[bp-music] ${error.message}; using the default BP music`);
    }
  }
  const ids = [...tracks.keys()];
  return {
    count: ids.length,
    select(seed) {
      // Check the count BEFORE modulo: an empty/missing directory must never divide by zero.
      if (ids.length === 0 || !Number.isSafeInteger(seed) || seed < 0) return null;
      return BP_MUSIC_PREFIX + ids[seed % ids.length];
    },
    async resolve(id) {
      if (!TRACK_ID.test(id)) return null;
      const track = tracks.get(id);
      if (!track || !root) return null;
      try {
        const stat = await fsp.lstat(track.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) return null;
        const real = await fsp.realpath(track.file);
        if (path.dirname(real) !== root) return null;
        await fsp.access(real, constants.R_OK);
        return { file: real, stat };
      } catch { return null; }
    },
  };
}
