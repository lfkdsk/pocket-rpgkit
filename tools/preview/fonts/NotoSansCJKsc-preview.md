# Preview Chinese font

`NotoSansCJKsc-preview.otf` is the font the project preview (Studio play-test) draws Chinese
text from. It is a pak entry of the preview app; when a loaded document uses characters
the preview's baked atlases lack, the preview bakes just those glyphs from this font.

- Source: [NotoSansCJKsc-Regular.otf](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf)
  at commit `f8d157532fbfaeda587e826d4cd5b21a49186f7c`, SHA-256 `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`.
`Inter-preview.otf` is a subset of Inter Regular (the kit's text face) for the characters
beyond ASCII that Inter draws; it is tried first. Its license is `LICENSE-Inter.txt`.

- Budget: GB2312 level-1 hanzi, GB2312 symbol rows, U+3000-303F and U+FF01-FF5E,
  less the characters Inter draws: 4302 characters, 1113748 bytes.

Regenerate with `bun tools/preview/gen-cjk-font.ts`; `--check` verifies the committed
files offline. The font is licensed under the SIL Open Font License 1.1; the copyright
notice and the license are in `LICENSE-NotoSansCJK.txt`, which the preview's pak and site
directory carry.
