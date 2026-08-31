import { runHttpServer, runStdioServer } from "./server.js";
import { errorMessage } from "./utils.js";

async function main(): Promise<void> {
  if (process.argv.includes("--http")) {
    await runHttpServer();
  } else {
    await runStdioServer();
  }
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
