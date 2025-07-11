import bot from "./src/index";

async function main () {
  try {
    bot.on("polling_error", (error) => {
      console.error("Polling error:", error);
    });
  }
  catch (error) {
    console.error("Failed to start bot:", error);
    process.exit(1);
  }
}

main();
