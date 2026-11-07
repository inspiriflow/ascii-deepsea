// New-tab page for the Chrome extension. The font ships inside the extension, so it works offline.
import "@fontsource/geist-mono/600.css";
import { OceanEngine } from "../src";

new OceanEngine(document.querySelector("canvas")!);
