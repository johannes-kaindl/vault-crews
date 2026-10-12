// `environment: "node"` kennt kein `window`; Code mit `realClock` (Kit-Abruf der Kontextlänge) ruft
// `window.setTimeout`. Ohne diesen Shim lieferte der Abruf still `null` (obsidian-kit 0.56.1, TSDoc).
import { installWindowTimers } from "./vendor/kit/window-timers";

installWindowTimers();
