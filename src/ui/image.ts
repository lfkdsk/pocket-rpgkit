// Opt-in TILESET-backed image entry. Kept separate from pocket-rpgkit/ui so
// projects using only the ordinary eager components do not bundle streaming.

export {
  LazyImage,
  TileTextureCache,
  type LazyImageProps,
  type RpgImageSource,
  type TileImageSource,
  type TileTextureCacheOptions,
  type TileTextureCacheStats,
} from "./LazyImage.tsx";
