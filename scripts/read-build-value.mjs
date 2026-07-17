import which from 'which';
import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Read one of bobshell's encrypted build-time values from an unmodified bundle.
 * This identifies the payload by structure, not by minified JavaScript names.
 */
export function readBuildValue(bundlePath, name) {
  const source = readFileSync(bundlePath, "utf8");

  // The UUID itself may change. Find UUID-tagged block-comment payloads and
  // select one containing the requested encrypted value.
  const startPattern = /\/\*\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:/gi;
  const candidates = [];

  for (const match of source.matchAll(startPattern)) {
    const start = match.index;
    const payloadStart = start + match[0].length;
    const close = source.indexOf(" */", payloadStart);
    if (close === -1) continue;

    const encodedPayload = source.slice(payloadStart, close).trim();
    const representations = [
      encodedPayload,
      // In the bundle the block is held in a JS string, so JSON quotes are
      // escaped in the source file but are ordinary quotes at runtime.
      encodedPayload.replace(/\\"/g, '"'),
    ];

    for (const representation of representations) {
      try {
        const payload = JSON.parse(representation);
        const entry = payload?.[name];
        if (entry?.encrypted && entry?.iv) {
          candidates.push({ start, end: close + " */".length, entry });
          break;
        }
      } catch {
        // This occurrence may be the marker's own string literal rather than
        // the encrypted payload. Continue scanning.
      }
    }
  }

  // DUn uses lastIndexOf(marker), so retain equivalent last-match behavior.
  const candidate = candidates.at(-1);
  if (!candidate) {
    throw new Error(`Encrypted build value ${JSON.stringify(name)} was not found`);
  }

  // Match U5s(): SHA-256 the exact bundle bytes except for the marked block.
  const digest = createHash("sha256")
    .update(source.slice(0, candidate.start))
    .update(source.slice(candidate.end))
    .digest();

  const iv = Buffer.from(candidate.entry.iv.data ?? candidate.entry.iv);
  const decipher = createDecipheriv("aes-256-cbc", digest, iv);
  return decipher.update(candidate.entry.encrypted, "hex", "utf8") + decipher.final("utf8");
}

console.log(readBuildValue(await which('bob'), 'BUILD_TIME_HMAC_SECRET'));
