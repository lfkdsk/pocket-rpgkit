// Source and licence inventory for the upstream Tuxemon assets copied into
// this example. Keep repoPath relative to the repository root so attribution
// and completeness checks can refer to the same stable name.

export type TuxemonAssetLicense =
  | "CC0"
  | "Public Domain / CC0"
  | "CC BY 3.0"
  | "CC BY 4.0"
  | "CC BY-SA 4.0";

export interface TuxemonAsset {
  repoPath: string;
  upstreamPath: string;
  title: string;
  author: string;
  license: TuxemonAssetLicense;
  source: string;
  modified?: string;
}

const SOURCE = "https://github.com/Tuxemon/Tuxemon";
const REVISION = "9e6258ff726b786040a267e8bdbbf037b560285e";
const REPO_ROOT = "examples/showcase/assets/tuxemon/";
const RGBA_REENCODE = "Re-encoded as RGBA PNG without changing the artwork.";

function asset(
  upstreamPath: string,
  title: string,
  author: string,
  license: TuxemonAssetLicense,
  options: { repoPath?: string; modified?: string } = {},
): TuxemonAsset {
  return {
    repoPath: `${REPO_ROOT}${options.repoPath ?? upstreamPath}`,
    upstreamPath,
    title,
    author,
    license,
    source: `${SOURCE}/blob/${REVISION}/${upstreamPath}`,
    ...(options.modified === undefined ? {} : { modified: options.modified }),
  };
}

export const TUXEMON_ASSETS: readonly TuxemonAsset[] = [
  asset(
    "mods/tuxemon/animations/technique/blue_circle.png",
    "Blue Circle Technique Animation",
    "Viktor Hahn; adapted by JaskRendix",
    "CC BY 4.0",
  ),
  asset(
    "mods/tuxemon/gfx/bubbles/note.png",
    "Music Note Bubble",
    "BilouMaster",
    "CC BY 4.0",
  ),
  asset(
    "mods/tuxemon/gfx/tilesets/core_city_and_country.png",
    "Core City and Country Tileset",
    "based on Outdoor Tiles - City and Country by ArMM1998 (Public Domain); Tuxemon compilation",
    "CC BY-SA 4.0",
    { modified: RGBA_REENCODE },
  ),
  asset(
    "mods/tuxemon/gfx/tilesets/Basic_Buch_Tiles_Compiled.png",
    "Basic Buch Tiles Compiled",
    "Buch; commissioned by luke83; changes and additions by luke83 and Past the Future",
    "CC BY 3.0",
    { modified: RGBA_REENCODE },
  ),
  asset(
    "mods/tuxemon/gfx/tilesets/Interior_Tiles_by_ArMM1998.png",
    "Interior Tiles",
    "ArMM1998",
    "Public Domain / CC0",
    { modified: RGBA_REENCODE },
  ),
  asset(
    "mods/tuxemon/sprites/girl1.png",
    "Girl 1",
    "josepharaoh99",
    "CC BY-SA 4.0",
    { modified: RGBA_REENCODE },
  ),
  asset(
    "mods/tuxemon/sprites/boss.png",
    "Boss",
    "josepharaoh99",
    "CC BY-SA 4.0",
    { modified: RGBA_REENCODE },
  ),
  asset(
    "mods/tuxemon/sprites/knight.png",
    "Knight",
    "Leo",
    "CC BY-SA 4.0",
    { modified: RGBA_REENCODE },
  ),
  asset(
    "mods/tuxemon/gfx/sprites/battle/bamboon-sheet.png",
    "Bamboon Battle Sprite Sheet",
    "Mike Bramson",
    "CC BY-SA 4.0",
    { modified: RGBA_REENCODE },
  ),
  asset(
    "mods/tuxemon/gfx/sprites/battle/bigfin-sheet.png",
    "Bigfin Battle Sprite Sheet",
    "Cavalcadeur and rsg167",
    "CC BY-SA 4.0",
    { modified: RGBA_REENCODE },
  ),
  asset(
    "mods/tuxemon/gfx/ui/combat/cavern_background.png",
    "Cavern Battle Background",
    "Leo",
    "CC BY-SA 4.0",
    { modified: RGBA_REENCODE },
  ),
  asset(
    "mods/tuxemon/music/JRPG_town_loop.ogg",
    "JRPG Town Loop",
    "Yubatake",
    "CC BY 3.0",
    {
      repoPath: "mods/tuxemon/music/JRPG_town_loop.wav",
      modified: "Converted from OGG, trimmed to a six-second loop, and resampled to mono 11,025 Hz PCM16 WAV.",
    },
  ),
  asset(
    "mods/tuxemon/sounds/setting/coinecho.wav",
    "Coin Echo",
    "NenadSimic",
    "CC BY 3.0",
    { modified: "Resampled to mono 11,025 Hz PCM16 WAV." },
  ),
  asset(
    "mods/tuxemon/sounds/monster/Bark.wav",
    "Bark",
    "Superpowers Asset Packs",
    "CC0",
    { modified: "Resampled to mono 11,025 Hz PCM16 WAV." },
  ),
  asset(
    "mods/tuxemon/sounds/monster/Ice.wav",
    "Ice",
    "bart",
    "CC0",
    { modified: "Resampled to mono 11,025 Hz PCM16 WAV." },
  ),
];
