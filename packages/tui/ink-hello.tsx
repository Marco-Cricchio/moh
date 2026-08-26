import { isatty } from "node:tty";
const out = process.stdout as unknown as { getWindowSize?: () => [number, number] };
console.log("getWindowSize:", typeof out.getWindowSize, out.getWindowSize?.(), "isatty0:", isatty(0), "isatty1:", isatty(1));
process.exit(0);
