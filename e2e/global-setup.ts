import fs from "node:fs";

/** Every run starts from an empty investigations folder (the test server's own, never yours). */
export default function globalSetup() {
  fs.rmSync(".investigations-e2e", { recursive: true, force: true });
  fs.mkdirSync(".investigations-e2e", { recursive: true });
}
