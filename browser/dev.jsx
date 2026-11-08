// Entry point. Sets up the globals bonk.io's game code expects (it was
// written to run inside bonk.io's own page), then mounts the app.
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App.jsx";
import "./dev.css";

globalThis.peerjs ??= {
  peerjs: {
    Peer: class MockPeer {
      constructor() {}
      on() {}
      connect() {
        return { on() {}, send() {}, close() {} };
      }
      destroy() {}
    },
  },
};

globalThis.dcodeIO ??= {
  PSON: {
    StaticPair: class StaticPair {
      constructor(dict) {
        this.dict = dict;
      }

      encode(obj) {
        return obj;
      }

      decode(obj) {
        return obj;
      }
    },
  },
};

console.log("GameResources loaded:", !!globalThis.GameResources);
console.log("PIXI loaded:", globalThis.PIXI?.VERSION);
console.log("Howler loaded:", !!globalThis.Howler);

globalThis.__bonkPatchGame = (core) => {
  core.game.getPageHeight = () => window.innerHeight;
  core.game.getPageWidth = () => window.innerWidth;
  core.game.mute = false;
};

globalThis.anime ??= function animeStub(config = {}) {
  if (typeof config.complete === "function") {
    setTimeout(config.complete, 0);
  }

  return {
    play() {},
    pause() {},
    restart() {},
    seek() {},
    finished: Promise.resolve(),
  };
};

globalThis.anime.timeline ??= function timelineStub() {
  return {
    add() {
      return this;
    },
    play() {},
    pause() {},
    restart() {},
    seek() {},
    finished: Promise.resolve(),
  };
};

if (globalThis.PIXI?.resources?.SVGResource) {
  const SVGResource = globalThis.PIXI.resources.SVGResource;
  const originalLoad = SVGResource.prototype.load;

  SVGResource.prototype.load = function patchedLoad() {
    if (typeof this.svg !== "string") {
      this.svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>`;
    }

    return originalLoad.call(this);
  };
}

createRoot(document.getElementById("root")).render(<App />);
