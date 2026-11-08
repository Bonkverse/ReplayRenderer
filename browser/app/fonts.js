// bonk.io's canvas text uses these faces (declared with @font-face in
// index.html). They must be loaded before the replay renderer draws names,
// or the first frames render in a fallback font.
let loaded = null;

export function loadBonkFonts() {
  loaded ??= Promise.all(
    ["fptmed", "fptbook", "fptb", "fptl", "futurept_medium", "futurept_book"].map((f) =>
      document.fonts.load(`16px "${f}"`).catch(() => null)
    )
  ).then(() => document.fonts.ready);
  return loaded;
}
