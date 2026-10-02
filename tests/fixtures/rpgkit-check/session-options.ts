import type { SessionOptions } from "../../../src/engine/session.ts";

/** Function-bearing options used to prove the CLI imports a TypeScript
 * module instead of trying to pass registrations through JSON. */
export default {
  extensions: {
    conditions: {
      "fixture.open": () => true,
    },
  },
} satisfies SessionOptions;
