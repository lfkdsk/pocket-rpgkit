import { randomBytes } from "node:crypto";

/**
 * A per-launch secret carried in the existing PKNT hello app field. The wire
 * format permits 64 bytes; base64url keeps 256 bits of entropy in 43 ASCII
 * bytes without extending PocketJS's generic protocol.
 */
export function createSvcWireAuthToken(): string {
  return randomBytes(32).toString("base64url");
}
