# Dreamcast for Brewser

Sega Dreamcast エミュレータを [Brewser](https://github.com/natureglass/Brewser)（Nintendo Switch 向け Web ランタイム）のアプリとしてパッケージしたものです。
コアは [Flycast WASM](https://github.com/nasomers/flycast-wasm)（Flycast の WebAssembly 移植 + SH4→WASM JIT、GPLv2）を使い、
このフォルダの `index.html` / `app.js` が RetroArch/libretro コアを直接駆動する小さなフロントエンドです。
PC のブラウザでもそのまま動きます。

## フォルダ構成

```
com.shirai.dreamcast/
├─ manifest.json         Brewser アプリマニフェスト
├─ index.html / app.js / style.css
├─ core/                 flycast_libretro.js + .wasm（GPLv2、ビルド済み）
├─ lib/                  fflate（zip 展開）, zipshim.js（コアに欠けている libzip 関数の JS 実装）
├─ bios/                 ← 任意: dc_boot.bin / dc_flash.bin（各自で吸い出したもの）
├─ games/                ← ゲーム（zip）と games.json
└─ tools/add-game.mjs    PC 用: ゲームを zip 化して games.json に登録
```

## Switch（Brewser）への入れ方

1. このフォルダごと SD カードの **`sd:/switch/brewser/apps/com.shirai.dreamcast/`** にコピー
2. Brewser を起動 → ローカルアプリ一覧に「Dreamcast」が出るので起動
3. D-pad / 左スティックで選択、**A** で起動。**+** でアプリ終了

BIOS が無い場合は Flycast の **HLE BIOS** で起動します（同梱の自作ソフトはこれで動きます）。
市販ソフトの多くも HLE で動きますが、実機 BIOS が必要なタイトルは `bios/` に置いてください。

## ゲームの追加

Brewser は既知の拡張子（`.zip` `.bin` `.data` …）しか配信しないので、ディスクイメージは **zip** にして `games/` に置きます。

```bash
# PC で（Node.js 18+）。複数ファイルの GDI は gdi とトラックをまとめて渡す
node tools/add-game.mjs path/to/game.cdi
node tools/add-game.mjs path/to/game.gdi path/to/track01.bin path/to/track02.raw path/to/track03.bin
```

手動で書く場合の `games/games.json`:

```json
{ "games": [
  { "title": "My Game",  "file": "mygame.zip" },
  { "title": "GDI game", "file": "game.zip", "launch": "game.gdi" },
  { "title": "Raw CHD",  "file": "game.chd.data", "as": "game.chd" }
]}
```

対応形式: CHD / CDI / GDI / CUE+BIN / ISO / ELF（Windows CE タイトルは未対応）。

## 操作

| Switch | Dreamcast |
|---|---|
| A / B / X / Y | 同じ**位置**のボタン（設定 "Buttons: label" で同じ**文字**に変更可） |
| ZL / ZR | L / R トリガー |
| 左スティック | アナログスティック |
| − (Minus) | Start |
| + (Plus) | アプリ終了（Brewser 予約） |
| キーボード | Z X A S = A B X Y, Enter = Start, Q/E = L/R, Esc = ランチャーへ |

## 仕組みメモ

- `core/flycast_libretro.js` は EmulatorJS 向けにビルドされた RetroArch + Flycast。`EJS_Runtime()` で Module を作り、
  MEMFS に `retroarch.cfg` / コアオプション / BIOS / ゲームを書いて `callMain([...])` する。入力は `simulate_input()`。
- 配布 WASM は libzip 未リンク（`--allow-undefined`）で、HLE BIOS のフォント資源（zip 埋め込み）を読むと abort するため、
  `Module.instantiateWasm` フックで `zip_*` インポートを `lib/zipshim.js`（fflate）に差し替えている。
- RetroArch の GL 初期化が `glGetString(GL_EXTENSIONS)` → WebGL2 では INVALID_ENUM で失敗するので、
  canvas の `getContext` をラップして `GL_EXTENSIONS` を `getSupportedExtensions()` から返す。
- セーブ（VMU）は `localStorage` に base64 で保存（30 秒ごと + 終了時）。manifest の `permissions: ["storage"]` が必要。

## ライセンス

- フロントエンド（index.html, app.js, style.css, lib/zipshim.js, tools/）: MIT
- Flycast / Flycast WASM core: GPLv2（`core/LICENSE.txt`）
- fflate: MIT
- 同梱テストゲーム（Demon Bazooka, Chroma Circuit, Gravity Wave）: MIT — [richstokes/dreamcast-homebrew](https://github.com/richstokes/dreamcast-homebrew)

BIOS やゲームは含まれていません。各自で合法的に用意してください。
