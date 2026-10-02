// Sunstone's opt-in demo menu data. Save codes are generated from safe
// points in journey.ts; tests regenerate and compare them so story edits
// cannot silently stale a chapter. Every chapter windows the one recorded
// tape: its suffix begins on the next source frame after the saved milestone,
// and timelineFrame puts the restored state back on the full run's global
// frame (a save carries only the per-map clock, reset by each transfer).

import { expandTapeRuns } from "../../src/engine/tape.ts";
import type { DemoOptions } from "../../src/ui/demo/index.ts";
import { DEMO_TAPE_RUNS } from "./demo-tape.ts";

export const SUNSTONE_DEMO_ORIGINS = {
  village: 0,
  forest: 239,
  cave: 461,
} as const;

export const SUNSTONE_DEMO_CODES = {
  village: "z1XVLLTsNADPwXn4MgTSkkR8QREAJuiINJnGbVfUS7TkpV5d_x5tFWPcWesWdsZ49QO2-QoQDfbneKbwL2dNunkEBPPihnoUgTqD0aguIugbKhchc6Ix1Vlj9ssgqlNjCy8Ecw2ArTK61xS0K0Gg_kI8N_UOQJ8GH8tJKl67UEhzmosVR2C8VKsAbD5GZcP4I16kAJ7FHvLvPA1D4rkV8NCTSkq7FJWSbfRs_z2GEf87BXLAsEiaUhkK6nSDGZGezRK_zVp5rGtZ_syt2Ubl30uF_2ehvl4X1aMgEfZ8vu7tdp_phvpN6gkgPaTmtpQY9ak56VjatQLxx52biaCHadzDgnyrYdv4h_BOatxbskQ5ZnpbKL037_CEO2kvt8ebShjmefnSf41fX04Tq-qn5CZn2FvV9YRBh_nWeqzt1iS3-8GMhf_-gsKzO-gbJBH0ebzpFmm_XqMXtY5cmJGYblgqPiIlNjNcfDMPwD",
  forest: "z1XVJNc5tADP0ve8YTA66NfWunx7aTSXPr9CCDgB32g9nV4mQy_u-RACeenBa9h6SnJ72p1gcLpE4qjN2gaRNhwocpV5maMETtnTrlmWoDWFSnbabqHushJssZRYGHdndA_jcSEPNvysLIDBfFSIyPBl4xCEEvXIjz6ZXfkhmJ9wyMDBTbintArV3HAWM9xKWd9dMMtmAiZuoCZriPI-H4U3OD4pqpHk2jTlV-5AraEYZRGn9KjxeJ40UTDxH5m3MimlbQSRsDHT6APWt0tLEp6pon-S5GrNz6biSbZo4LaEIb5wF7H9xmQJmP8QmChrP56NP78S_5eljCzovUcntz6M-sUT0udmUqyIzl9tsuP1bHPSdY0LwJl4zhFAhgDJq1tPUNmBuHgZ1rFoJ8YqlroN2Y6BcLEGB1j3vXaHnctVKdRO6__8yga9jn5wAutrLAtfMC__YTPvlEX_7-AUTmC_Z410JgOPtA2NxnQ2q0FwfPnZVHs0AVk4vkHW6o53RZgjdJPCr4UkbZoJyT-OejJj7TZ81nyXRZXa88Cr7QTTSf5FNypO18oHUPYd7XbHFe7ndFVR6KY_bBSPqylVnlrUwLzfrNDd4B",
  cave: "z1XVJNc5tADP0ve4axsaljuLXTY9vJpLl1epBBwI73g9nV4mQy_u-VADdOTqzeQ0_Sk95U54MFUrUKY3_WlEeYcDMVKlMThqi9U3WRqS6ARVVvM9UM2JxjspyBx31XdSXyv5GAmH9TFkZmGhZhdDTwikFgelF1lSl6ZTWWGzksypIfAjwcuAA02vWq3jE2QFxqWT_NYAcmYqYuYM73cSQcv2vW310zNaBpVX0sKlbQjjCMUve973iROF408QRR3iE5zI3m2SkkZImIphNi0sZAjxuwJ42Ocpuibniqr2LKyq3fXMRo5dhKDjazbiTv8CNOgw8u72ejGOeCmtDOrSzUGcUNxicIGk5mblP6Gvz4m3xzXsLey6T77c3fX_OI6nExO1NBLNpvv5RFdawOnGBB8xZdMoZTIIAxaFZp61swNw4DG98uBPnEo62BdmOiH9yAAKv5XLtBy_asSk2Sdv_8ZQZdy2t6DuBiJ-tfKy_wTz_hk0_06e9vQGQ-YY93JQSGkw-E7X02pFZ7cfDUW_loblDF5Gb7cxo4XZbmTRKPdkfWlgNgm7fin4-a-MSfNZ-0qsvD9nrlUfCFbk3zOT8lR9rOx90MEJbTEYuL_aHcHfcPuyr7z0j6spW5y5tMB-365gL_AA",
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
      tape: fullTape,
      tapeStart: SUNSTONE_DEMO_ORIGINS.forest,
      timelineFrame: SUNSTONE_DEMO_ORIGINS.forest,
    },
    {
      id: "cave",
      title: "Cave gate",
      snapshot: SUNSTONE_DEMO_CODES.cave,
      tape: fullTape,
      tapeStart: SUNSTONE_DEMO_ORIGINS.cave,
      timelineFrame: SUNSTONE_DEMO_ORIGINS.cave,
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
