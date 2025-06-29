import TelegramBot from "node-telegram-bot-api";
import { handleAdminCommands } from "./admin";
import {
  updateUserActivity,
  upsertUser
} from "./database";
import {
  BOT_TAG,
  helpMessage,
  isAdmin,
  isYoutubeShortsLink,
  processFeatureRequest,
  processNewsletterToggle,
  processSocialMedia,
  processYouTubeShorts,
  safeSendMessage,
  sendErrorToAdmin,
  shutdown
} from "./utils";

const token = Bun.env.TELEGRAM_BOT!;
Bun.env.NTBA_FIX_350 = "1";
const bot = new TelegramBot(token, { polling: true });

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await safeSendMessage(
    bot,
    chatId,
    [
      "Привет! 👋",
      "",
      "Я бот для скачивания медиа из социальных сетей. ✨",
      "",
      "Я могу:",
      "— скачивать видео из TikTok ",
      "— скачивать рилсы, посты и сторис с Instagram",
      "— скачивать видео из Facebook",
      "— скачивать видео и изображения из Twitter (X)",
      "— скачивать YouTube Shorts",
      "",
      BOT_TAG
    ].join("\n")
  );
  return;
});

bot.onText(/(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const username = msg.from?.username;
  const firstName = msg.from?.first_name;
  const message = match?.[1]!;

  if (message && message === "/start") {
    return;
  }

  if (message && message === "/help") {
    await safeSendMessage(bot, chatId, helpMessage);
    return;
  }

  if (message && message === "/newsletter") {
    await processNewsletterToggle(bot, chatId, username);
    return;
  }

  if (message && message.startsWith("/feat")) {
    await processFeatureRequest(bot, chatId, message, username, firstName);
    return;
  }

  const isValidUrl = message && (message.includes("https://") || message.includes("http://")) &&
                     message.trim() !== "" && message.trim().length >= 10;

  const isAdminCommand = isAdmin(userId) && message && message.startsWith("/");

  if (!isValidUrl && !isAdminCommand) {
    await safeSendMessage(bot, chatId, helpMessage);
    return;
  }

  try {
    upsertUser(chatId, username, firstName);
    updateUserActivity(chatId);

    if (isAdmin(userId)) {
      const handled = await handleAdminCommands(bot, chatId, message, userId);
      if (handled) return;
    }

    if (isYoutubeShortsLink(message)) {
      await processYouTubeShorts(bot, chatId, message, username, firstName);
    }
    else {
      await processSocialMedia(bot, chatId, message, username, firstName);
    }
  }
  catch (error: any) {
    const errorMessage = error && typeof error === "object" ? (error.message || String(error)) : String(error);

    if (errorMessage.includes("bot was blocked by the user") ||
        errorMessage.includes("user is deactivated") ||
        errorMessage.includes("chat not found") ||
        errorMessage.includes("ETELEGRAM: 403 Forbidden")) {
      return;
    }

    await sendErrorToAdmin(bot, error, "main function", message, chatId, username);
  }
});

process.on("SIGINT", () => shutdown("SIGINT", bot));
process.on("SIGTERM", () => shutdown("SIGTERM", bot));

console.log("Bot started successfully!");

export default bot;
