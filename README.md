# Switch2Dreamcast — Brewser で動く Dreamcast エミュレータ

| パス | 内容 |
|---|---|
| `app/com.shirai.dreamcast/` | **成果物。Brewser アプリ本体**（詳細は中の README.md） |
| `dist/com.shirai.dreamcast.zip` | 上記を zip にしたもの。展開して `sd:/switch/brewser/apps/` に置く |
| `tools/deploy-to-sd.ps1` | SD カードへコピーする PowerShell スクリプト（`-Drive E:`） |
| `Brewser/` | natureglass/Brewser のクローン（シェルの仕様調査に使用） |
| `flycast-wasm/` | nasomers/flycast-wasm のクローン（コアの出典。`core/` の js/wasm は v1.0 リリース物） |
| `flycast-src/` | flyinghead/flycast @2c48c01（コードリーディング用、部分チェックアウト） |
| `EmulatorJS/` | EmulatorJS のクローン（コアとの契約を調べるための参考。アプリには未使用） |
| `testroms/` | MIT ライセンスの自作 DC ゲーム（richstokes/dreamcast-homebrew） |
| `.claude/launch.json` | PC でのプレビュー用ローカルサーバ（`python -m http.server 8765`） |

PC で試す:

```bash
python -m http.server 8765 --directory app/com.shirai.dreamcast
```

→ http://localhost:8765/ （`?debug` を付けると RetroArch/Flycast の詳細ログ）
