import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
function walk(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${item.name}`;
    if (item.isDirectory()) walk(path);
    else if (path.endsWith(".js")) {
      const result = spawnSync(process.execPath, ["--check", path], {
        stdio: "inherit",
      });
      if (result.status) process.exit(result.status);
    }
  }
}
walk("backend");
walk("scripts");
console.log("JavaScript syntax checks passed");
