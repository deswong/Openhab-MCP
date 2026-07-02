import fs from 'fs';

/**
 * Utility to read the last N lines of a file without loading the whole file into memory,
 * fully asynchronous to prevent blocking the event loop.
 */
export async function readLastLines(filePath: string, maxLines: number): Promise<string[]> {
  let fileHandle: fs.promises.FileHandle | null = null;
  try {
    const exists = await fs.promises.access(filePath, fs.constants.F_OK).then(() => true).catch(() => false);
    if (!exists) return [];

    const stats = await fs.promises.stat(filePath);
    const fileSize = stats.size;
    const bufferSize = Math.min(fileSize, 65536); // 64KB chunks
    const buffer = Buffer.alloc(bufferSize);

    fileHandle = await fs.promises.open(filePath, 'r');
    let lines: string[] = [];
    let position = fileSize;

    while (lines.length <= maxLines && position > 0) {
      const readSize = Math.min(position, bufferSize);
      position -= readSize;
      await fileHandle.read(buffer, 0, readSize, position);

      const chunk = buffer.subarray(0, readSize).toString();
      const chunkLines = chunk.split('\n');

      // If we're not at the very end of the file, the first line of this chunk might be partial
      // and should be merged with the last line of the previous chunk.
      if (lines.length > 0) {
        lines[0] = (chunkLines.pop() || '') + lines[0];
      }

      lines = [...chunkLines, ...lines];
    }

    return lines.slice(-maxLines).filter((l) => l.trim().length > 0);
  } catch (error) {
    console.error(`[LogParser] Error reading ${filePath}:`, error);
    return [];
  } finally {
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch (err) {
        console.error(`[LogParser] Error closing ${filePath}:`, err);
      }
    }
  }
}

/**
 * Parses events.log format into a standard event log string.
 */
export function normalizeEventLog(line: string): string | null {
  // Format: 2026-03-21 19:19:12.397 [INFO ] [openhab.event.ItemStateChangedEvent] - Item 'MultiSense_Laundry_Occupancy' changed from ON to OFF
  const match = line.match(
    /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[.*?\] \[(.*?)\] - (.*)$/
  );
  if (!match) return null;

  const [, timestamp, eventSubtype, content] = match;
  const type = eventSubtype.split('.').pop() || eventSubtype;
  return `${timestamp} - ${type} - ${content}`;
}
