# Dreamcast for Brewser

Sega Dreamcast エミュレータを [Brewser](https://github.com/natureglass/Brewser)（Nintendo Switch 向け Web ランタイム）のアプリとしてパッケージしたものです。
コアは [Flycast WASM](https://github.com/nasomers/flycast-wasm)（Flycast の WebAssembly 移植 + SH4→WASM JIT、GPLv2）を使い、
このフォルダの `index.html` / `app.js` が RetroArch/libretro コアを直接駆動する小さなフロントエンドです。
PC のブラウザでもそのまま動きます。

## フォルダ構成

```
com.shirai.dreamcast/
├─ manifest.json         Brewser アプリマニフェスト
├─ index.html            UI・CSS・フロントエンド・libzip シムを全部含む1枚もの
├─ core/                 flycast_libretro.js + .wasm（GPLv2、ビルド済み）
├─ lib/fflate.min.js     zip 展開（index.html から使用）
├─ lib/fflate.mjs        同上の ESM 版（tools/add-game.mjs 用、アプリは使わない）
├─ bios/                 ← 任意: dc_boot.bin / dc_flash.bin（各自で吸い出したもの）
├─ games/                ← ゲーム（zip）と games.json
└─ tools/add-game.mjs    PC 用: ゲームを zip 化して games.json に登録
```

`index.html` が1枚にまとまっているのは意図的です（→「Brewser で踏んだ落とし穴」）。

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

### 大きいイメージ（GD-ROM 吸い出しなど）

1GB 級のイメージを zip に入れると、zip 本体と展開後で**ピーク時にサイズの2倍**のメモリを使います。
`files` を使うと zip を介さずトラックを1本ずつ直接読み込むので、ピークは1本分で済みます。
`.gdi` / `.cue` シートは小さなテキストなので `inline` に直接書けます（Brewser が配信しない拡張子の回避にもなる）。

```json
{
  "title": "My GD-ROM game",
  "launch": "game.gdi",
  "inline": {
    "game.gdi": "3\n1     0 4 2352 \"track01.bin\" 0\n2   450 0 2352 \"track02.bin\" 0\n3 45000 4 2352 \"track03.bin\" 0\n"
  },
  "files": [
    { "url": "mygame/track01.bin", "as": "track01.bin" },
    { "url": "mygame/track02.bin", "as": "track02.bin" },
    { "url": "mygame/track03.bin", "as": "track03.bin" }
  ]
}
```

トラックのファイル名は**スペースや括弧を含まない ASCII** にしてください（`inline` の .gdi 内の名前と一致させる）。

**メモリの注意**: ディスクイメージは丸ごとメモリに載ります。1.2GB の GD-ROM 吸い出しで
JS ヒープ実測 **約1.14GB**。PC ブラウザでは問題ありませんが、**Switch 実機で収まるかは未検証**です。
hbmenu を full application mode（R を押しながら起動）で立ち上げるか、CHD 化して小さくしてください。

**リージョン**: 設定の Region は既定が Japan です。USA / Europe 版のディスクでは合わせて変えてください
（合っていないとゲーム内の言語や表示がずれます）。

## 操作

| Switch | Dreamcast |
|---|---|
| A / B / X / Y | 同じ**位置**のボタン（設定 "Buttons: label" で同じ**文字**に変更可） |
| ZL / ZR | L / R トリガー |
| 左スティック | アナログスティック |
| D-pad | 十字キー |
| − (Minus) | Start |
| + (Plus) | アプリ終了（Brewser 予約） |
| 左スティック押し込み 1秒 | 画面内ログの表示切替 |
| キーボード | Z X A S = A B X Y, Enter = Start, Q/E = L/R, Esc = ランチャーへ, F1 = ログ |

**ボタンが効かない場合**: Brewser は既定で A=クリック, B=右クリック, X=アドレスバー, ZL=ブックマーク,
ZR=ホーム, −=設定, ↑↓=スクロールをシェル側で消費します。`manifest.json` の `buttonMapping` が
これらを全部空文字にして解放していますが、もし解放されない場合は
`sd:/switch/brewser/configs/config.json` の `buttonMapping` を直接空にしてください。

## 仕組みメモ

- `core/flycast_libretro.js` は EmulatorJS 向けにビルドされた RetroArch + Flycast。`EJS_Runtime()` で Module を作り、
  MEMFS に `retroarch.cfg` / コアオプション / BIOS / ゲームを書いて `callMain([...])` する。入力は `simulate_input()`。
- 配布 WASM は libzip 未リンク（`--allow-undefined`）で、HLE BIOS のフォント資源（zip 埋め込み）を読むと abort するため、
  `Module.instantiateWasm` フックで `zip_*` インポート 12 個を fflate ベースの実装に差し替えている。
- RetroArch の GL 初期化が `glGetString(GL_EXTENSIONS)` → WebGL2 では INVALID_ENUM で失敗するので、
  canvas の `getContext` をラップして `GL_EXTENSIONS` を `getSupportedExtensions()` から返す。
- セーブ（VMU）は `localStorage` に base64 で保存（30 秒ごと + 終了時）。manifest の `permissions: ["storage"]` が必要。

## Brewser で踏んだ落とし穴（他のアプリを作る人向け）

Brewser は DOM/HTML/CSS/JS をゼロから実装した独自エンジンなので、PC ブラウザで動いても通らない書き方があります。
このアプリで対策済みのものを挙げます。

| 項目 | 対策 |
|---|---|
| **毎フレーム描く canvas** | **WebGL 必須**。Canvas 2D はベイクされた要素キャッシュから合成されるため、中身を書き換えても画面が更新されないことがある。このアプリのエミュ画面は WebGL2（コアが `MIN_WEBGL_VERSION=2` でリンク済み） |
| **canvas のサイズ** | **HTML 属性で宣言**（`<canvas width="1280" height="720">`）。GL ブリッジは IDL プロパティではなく**属性**を見るので、`canvas.width = N` の代入はブリッジに伝わらず、描画サイズとコピーサイズがズレて引き伸ばされる。Emscripten は自分で代入してくるため、Brewser 上では setter で**代入を無視して宣言サイズに固定**している |
| **JS ファイル分割** | クラシックスクリプト間で共有されるのは `var` と関数宣言だけ。**`class` / `let` / `const` は跨げない**ので、自前のコードは `index.html` に全部インライン化した。外部のままなのは明示的にグローバルへ代入するもの（fflate → `self.fflate`、コア → `var EJS_Runtime`）だけ |
| **ボタンが効かない** | `manifest.json` の `buttonMapping` でシェル側の割当を全部空文字にして解放する。形式は **アクション→ボタン**（`{"leftClick": "", "rightClick": "", ...}`）で、**空文字＝解放**。既定では A=leftClick, B=rightClick, X=addressBar, L=back, R=forward, ZL=bookmark, ZR=home, −=settings, ↑↓=scroll が全部シェルに取られる |
| **ランチャーにアプリが出ない** | `manifest.json` に **`publishedAt`**（ISO8601Z）が必要。シェル既定の `homeSection` は `recent` で、これは `publishedAt` で並べるため、無いアプリはカードごと出ずインストールされていないように見える。未知のトップレベルキーも増やさないほうが無難 |
| **`await requestAnimationFrame` で固まる** | 画面が描画されていない間（バックグラウンド等）rAF は**一度も発火しない**。フレームを譲る処理は必ず `setTimeout` と競争させる。実際これを入れ忘れてローディング 5% でデッドロックした |
| **デバッグ手段がない** | `console.log` も `console.error` も実機では読めない。画面内ログパネルを内蔵し、エラー時は自動で開くようにした（左スティック押し込み1秒 / F1 / `?debug`） |
| その他 | `aspect-ratio` CSS と `<table>` は避ける（CSS/HTML エンジンのカバー率が部分的）。`btoa`/`atob`・`performance.now`・`location.reload` にもフォールバックを用意 |

## ライセンス

- フロントエンド（index.html, app.js, style.css, lib/zipshim.js, tools/）: MIT
- Flycast / Flycast WASM core: GPLv2（`core/LICENSE.txt`）
- fflate: MIT
- 同梱テストゲーム（Demon Bazooka, Chroma Circuit, Gravity Wave）: MIT — [richstokes/dreamcast-homebrew](https://github.com/richstokes/dreamcast-homebrew)

BIOS やゲームは含まれていません。各自で合法的に用意してください。
