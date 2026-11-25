import { appendFileSync, renameSync, statSync } from 'node:fs';

const MAX_LOG_BYTES = 8 * 1024 * 1024;

function sizeOf(file) {
  try { return statSync(file).size; } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return 0;
  }
}

export function fileLog(file, maxBytes = MAX_LOG_BYTES) {
  let reportedFailure = false;
  return (line) => {
    try {
      const size = sizeOf(file);
      if (size && size + Buffer.byteLength(line) + 1 > maxBytes) renameSync(file, `${file}.1`);
      appendFileSync(file, `${line}\n`, { mode: 0o600 });
      reportedFailure = false;
    } catch (error) {
      if (!reportedFailure) console.error(`本地日志写入失败 [${error.code ?? 'LOG_WRITE'}]`);
      reportedFailure = true;
    }
  };
}
