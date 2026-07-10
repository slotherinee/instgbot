// @ts-ignore - no types available
import input from "input";
import { bot, userClient } from "./bot/client";
import { registerMessageHandlers } from "./bot/router";
import { registerCallbackHandlers } from "./bot/callbacks";
import { notifyAdmins, shutdown } from "./utils/messages";
import { readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";

registerMessageHandlers(bot, userClient);
registerCallbackHandlers(bot);

readdir(tmpdir()).then(files =>
  Promise.all(
    files.filter(f => f.startsWith("yt_"))
      .map(f => {
        const full = `${tmpdir()}/${f}`;
        return f.startsWith("ytpipe-")? rm(full, { recursive: true, force: true }).catch(() => {}): unlink(full).catch(() => {});
      })
  )
).catch(() => {});

(async () => {
  await userClient.start({
    phoneNumber: () => input.text("Phone number: "),
    password: () => input.text("2FA password (if any): "),
    phoneCode: () => input.text("Code: "),
    onError: console.log
  });
  userClient.session.save();
})();

process.on("SIGINT", async () => {
  await notifyAdmins(bot, "Bot is shutting down due to SIGINT signal");
  shutdown("SIGINT", bot);
});
process.on("SIGTERM", async () => {
  await notifyAdmins(bot, "Bot is shutting down due to SIGTERM signal");
  shutdown("SIGTERM", bot);
});

console.log("Bot started successfully!");

export default bot;
