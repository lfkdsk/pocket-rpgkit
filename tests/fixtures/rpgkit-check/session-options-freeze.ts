import type { SessionOptions } from "../../../src/engine/session.ts";

/** Named-export coverage for the CLI session-module loader. */
export const sessionOptions = {
  extensions: {
    conditions: {
      "fixture.freeze": () => true,
    },
  },
} satisfies SessionOptions;
