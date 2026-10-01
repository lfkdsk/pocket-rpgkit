// Sunstone's opt-in demo menu data. Save codes are generated from safe
// points in journey.ts; tests regenerate and compare them so story edits
// cannot silently stale a chapter. Tape suffixes begin on the next source
// frame after each saved milestone.

import { expandTapeRuns } from "../../src/engine/tape.ts";
import type { DemoOptions } from "../../src/ui/demo/index.ts";
import { DEMO_TAPE_RUNS } from "./demo-tape.ts";

export const SUNSTONE_DEMO_ORIGINS = {
  village: 0,
  forest: 239,
  cave: 461,
} as const;

export const SUNSTONE_DEMO_CODES = {
  village: "eyJmb3JtYXQiOiJycGdraXQtc2F2ZS92MSIsInZlcnNpb24iOjEsImZyYW1lIjowLCJjaGVja3N1bSI6IjU5MDE4MjZjIiwic3RhdGUiOnsibWFwIjoidmlsbGFnZSIsInBsYXllciI6eyJ0eCI6OSwidHkiOjksInB4IjoxNDQsInB5IjoxNDQsImZhY2luZyI6MiwicGhhc2UiOjAsIm1vdmluZyI6ZmFsc2UsIndhbGtpbmciOmZhbHNlLCJzdGVwRGlyIjoyfSwiaGVsZCI6MCwiaW50ZXJwIjp7ImZyYW1lIjowLCJzdyI6eyJzd2l0Y2hlcyI6e30sInNlbGYiOnt9LCJpdGVtcyI6e30sInZhcmlhYmxlcyI6e30sInNob3BTdG9jayI6e30sImdvbGQiOjUsInBsYXllck5hbWUiOiJQbGF5ZXIiLCJybmciOjMwNTQxOTg5Nn0sIm1haW4iOm51bGwsInBhcmFsbGVscyI6e30sIm1vZGFsIjpudWxsLCJlcmFzZWQiOnt9LCJ0b3VjaGVkIjp7fSwiaW5wdXRMb2NrZWQiOmZhbHNlLCJwbGFjZW1lbnRzIjp7fSwiY3VlcyI6W10sInBlbmRpbmdUcmFuc2ZlciI6bnVsbCwicGVuZGluZ01vdmVSb3V0ZXMiOltdLCJwZW5kaW5nQmF0dGxlcyI6W10sInBlbmRpbmdQbGFjZW1lbnRzIjpbXSwiYWJvcnRlZFJvdXRlcyI6W119LCJleHQiOm51bGx9fQ",
  forest: "eyJmb3JtYXQiOiJycGdraXQtc2F2ZS92MSIsInZlcnNpb24iOjEsImZyYW1lIjowLCJjaGVja3N1bSI6IjFhZWJhNjI5Iiwic3RhdGUiOnsibWFwIjoiZm9yZXN0IiwicGxheWVyIjp7InR4IjoxMCwidHkiOjEzLCJweCI6MTYwLCJweSI6MjA4LCJmYWNpbmciOjIsInBoYXNlIjowLCJtb3ZpbmciOmZhbHNlLCJ3YWxraW5nIjpmYWxzZSwic3RlcERpciI6Mn0sImhlbGQiOjgxOTIsImludGVycCI6eyJmcmFtZSI6MCwic3ciOnsic3dpdGNoZXMiOnt9LCJzZWxmIjp7InZpbGxhZ2UvdmlsbGFnZS1jaGVzdCI6IkEifSwiaXRlbXMiOnsidGhvcm4ta2V5IjoxfSwidmFyaWFibGVzIjp7fSwic2hvcFN0b2NrIjp7fSwiZ29sZCI6MzAsInBsYXllck5hbWUiOiJQbGF5ZXIiLCJybmciOjMwNTQxOTg5Nn0sIm1haW4iOm51bGwsInBhcmFsbGVscyI6e30sIm1vZGFsIjpudWxsLCJlcmFzZWQiOnt9LCJ0b3VjaGVkIjp7fSwiaW5wdXRMb2NrZWQiOmZhbHNlLCJwbGFjZW1lbnRzIjp7fSwiY3VlcyI6W10sInBlbmRpbmdUcmFuc2ZlciI6bnVsbCwicGVuZGluZ01vdmVSb3V0ZXMiOltdLCJwZW5kaW5nQmF0dGxlcyI6W10sInBlbmRpbmdQbGFjZW1lbnRzIjpbXSwiYWJvcnRlZFJvdXRlcyI6W119LCJleHQiOm51bGx9fQ",
  cave: "eyJmb3JtYXQiOiJycGdraXQtc2F2ZS92MSIsInZlcnNpb24iOjEsImZyYW1lIjowLCJjaGVja3N1bSI6IjE3ZGRiYTBlIiwic3RhdGUiOnsibWFwIjoiY2F2ZSIsInBsYXllciI6eyJ0eCI6OSwidHkiOjExLCJweCI6MTQ0LCJweSI6MTc2LCJmYWNpbmciOjIsInBoYXNlIjowLCJtb3ZpbmciOmZhbHNlLCJ3YWxraW5nIjpmYWxzZSwic3RlcERpciI6Mn0sImhlbGQiOjgxOTIsImludGVycCI6eyJmcmFtZSI6MCwic3ciOnsic3dpdGNoZXMiOnsicnVuZS1saXQiOnRydWV9LCJzZWxmIjp7InZpbGxhZ2UvdmlsbGFnZS1jaGVzdCI6IkEiLCJmb3Jlc3QvcnVuZS1zdG9uZSI6IkEiLCJmb3Jlc3QvdGhvcm4tZ2F0ZSI6IkEifSwiaXRlbXMiOnsidGhvcm4ta2V5IjoxfSwidmFyaWFibGVzIjp7fSwic2hvcFN0b2NrIjp7fSwiZ29sZCI6MzAsInBsYXllck5hbWUiOiJQbGF5ZXIiLCJybmciOjMwNTQxOTg5Nn0sIm1haW4iOm51bGwsInBhcmFsbGVscyI6e30sIm1vZGFsIjpudWxsLCJlcmFzZWQiOnt9LCJ0b3VjaGVkIjp7fSwiaW5wdXRMb2NrZWQiOmZhbHNlLCJwbGFjZW1lbnRzIjp7fSwiY3VlcyI6W10sInBlbmRpbmdUcmFuc2ZlciI6bnVsbCwicGVuZGluZ01vdmVSb3V0ZXMiOltdLCJwZW5kaW5nQmF0dGxlcyI6W10sInBlbmRpbmdQbGFjZW1lbnRzIjpbXSwiYWJvcnRlZFJvdXRlcyI6W119LCJleHQiOm51bGx9fQ",
} as const;

const fullTape = expandTapeRuns(DEMO_TAPE_RUNS);

export const SUNSTONE_DEMO: DemoOptions = {
  chapters: [
    {
      id: "village",
      title: "Village beginning",
      snapshot: SUNSTONE_DEMO_CODES.village,
      tape: fullTape,
    },
    {
      id: "forest",
      title: "Whispering Wood",
      snapshot: SUNSTONE_DEMO_CODES.forest,
      tape: fullTape.slice(SUNSTONE_DEMO_ORIGINS.forest),
    },
    {
      id: "cave",
      title: "Cave gate",
      snapshot: SUNSTONE_DEMO_CODES.cave,
      tape: fullTape.slice(SUNSTONE_DEMO_ORIGINS.cave),
    },
  ],
  warp: {
    spawns: {
      village: { x: 9, y: 9, dir: "up" },
      forest: { x: 10, y: 12, dir: "up" },
      cave: { x: 9, y: 10, dir: "up" },
    },
  },
};
