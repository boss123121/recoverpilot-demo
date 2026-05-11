const { makeScheduledMessagesDue } = require("../src/retargeting");
const { readState, writeState } = require("../src/state");

async function main() {
  const state = await readState();
  const changed = makeScheduledMessagesDue(state);
  await writeState(state);
  console.log(`Marked ${changed} scheduled message(s) as due.`);
}

main().catch((error) => {
  console.error("Could not mark messages as due.");
  console.error(error.message);
  process.exitCode = 1;
});
