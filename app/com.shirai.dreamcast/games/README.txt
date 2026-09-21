Put your Dreamcast disc images here, ZIPPED, and list them in games.json.

Why zip?  Brewser only serves files with known extensions (.zip / .bin / .data ...),
so .cdi / .gdi / .chd / .cue are wrapped in a zip and extracted in memory at launch.

  games.json entry:
    { "title": "My Game", "file": "mygame.zip" }
    { "title": "GDI game", "file": "game.zip", "launch": "game.gdi" }   // multi-file (gdi + track*.bin)
    { "title": "Raw CHD",  "file": "game.chd.data", "as": "game.chd" }  // unzipped, renamed to an allowed extension

  PC: node tools/add-game.mjs path/to/game.cdi [more files...]   (zips + updates games.json)
