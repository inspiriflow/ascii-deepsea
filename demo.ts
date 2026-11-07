import { OceanEngine } from "./src";

// ?only=orca,humpback — limit the animals (fish always swim). No param: the full cast.
const only = new URLSearchParams(location.search).get("only")?.split(",").filter(Boolean);

new OceanEngine(document.querySelector("canvas")!, only);
