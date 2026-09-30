import { hashPassword } from "../backend/src/auth.js";
if (process.stdin.isTTY) {
  console.error(
    "Pipe a password from a secret manager or hidden shell prompt into this command; do not put it in command arguments.",
  );
  process.exit(1);
}
let value = "";
for await (const chunk of process.stdin) value += chunk;
if (value.trim().length < 12) throw Error("Use at least 12 characters");
console.log(hashPassword(value.trim()));
