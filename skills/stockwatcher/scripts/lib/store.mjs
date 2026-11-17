// Saving small files safely on every system.
import { writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

// Writes the file whole or not at all (a temporary file, then a rename). Never throws: returns
// false and logs instead, so a full or read-only disk cannot break a request.
// Windows: renaming over a file that a virus scanner or another program holds open fails
// (EPERM, EBUSY); the file is then written in place.
export function saveFile(path, body, log = () => {}) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + '.tmp';
    writeFileSync(tmp, body);
    try { renameSync(tmp, path); } catch {
      writeFileSync(path, body);
      try { unlinkSync(tmp); } catch { /* left behind, overwritten next time */ }
    }
    return true;
  } catch (e) {
    log('not saved: ' + path + ' (' + e.message + ')');
    return false;
  }
}
