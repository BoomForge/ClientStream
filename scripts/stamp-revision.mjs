import { writeFileSync } from "node:fs";

const revision = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(revision || "")) throw new Error("A validated 40-character Git commit SHA is required.");
writeFileSync(new URL("../src/revision.ts", import.meta.url), `export const DEPLOY_REVISION = "${revision}";\n`);
console.log("Stamping validated ClientStream revision", revision);
