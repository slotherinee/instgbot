import TelegramBot from "node-telegram-bot-api";
import { snapsave } from "snapsave-media-downloader";
import { youtube } from "btch-downloader";
import { closeDatabase, detectPlatform, recordDownload, recordError } from "./database";

export const BOT_TAG = "@instg_save_bot";
export const ADMIN_USERNAME = Bun.env.ADMIN_USERNAME!;
export const ADMIN_USER_IDS = [324025710, 542142955];

export const isAdmin = (userId?: number): boolean => {
  if (!userId) return false;
  return ADMIN_USER_IDS.includes(userId);
};

export class FileTooLargeError extends Error {
  constructor (size: number) {
    super(`File too large: ${Math.round(size / 1024 / 1024)}MB (limit: 50MB)`);
    this.name = "FileTooLargeError";
  }
}

// Функция для безопасной отправки сообщений с обработкой блокировки
export const safeSendMessage = async (
  bot: TelegramBot,
  chatId: number,
  text: string,
  options?: TelegramBot.SendMessageOptions
): Promise<TelegramBot.Message | null> => {
  try {
    return await bot.sendMessage(chatId, text, options);
  }
  catch (error: any) {
    const errorMessage = error && typeof error === "object" ? (error.message || String(error)) : String(error);

    if (errorMessage.includes("bot was blocked by the user") ||
        errorMessage.includes("user is deactivated") ||
        errorMessage.includes("chat not found") ||
        errorMessage.includes("ETELEGRAM: 403 Forbidden")) {
      return null;
    }

    // Если это не ошибка блокировки, пробрасываем дальше
    throw error;
  }
};

// Функция для безопасной отправки видео
export const safeSendVideo = async (
  bot: TelegramBot,
  chatId: number,
  video: string | Buffer,
  options?: TelegramBot.SendVideoOptions
): Promise<TelegramBot.Message | null> => {
  try {
    return await bot.sendVideo(chatId, video, options);
  }
  catch (error: any) {
    const errorMessage = error && typeof error === "object" ? (error.message || String(error)) : String(error);

    if (errorMessage.includes("bot was blocked by the user") ||
        errorMessage.includes("user is deactivated") ||
        errorMessage.includes("chat not found") ||
        errorMessage.includes("ETELEGRAM: 403 Forbidden")) {

      return null;
    }

    throw error;
  }
};

// Функция для безопасной отправки фото
export const safeSendPhoto = async (
  bot: TelegramBot,
  chatId: number,
  photo: string | Buffer,
  options?: TelegramBot.SendPhotoOptions
): Promise<TelegramBot.Message | null> => {
  try {
    return await bot.sendPhoto(chatId, photo, options);
  }
  catch (error: any) {
    const errorMessage = error && typeof error === "object" ? (error.message || String(error)) : String(error);

    if (errorMessage.includes("bot was blocked by the user") ||
        errorMessage.includes("user is deactivated") ||
        errorMessage.includes("chat not found") ||
        errorMessage.includes("ETELEGRAM: 403 Forbidden")) {

      return null;
    }

    throw error;
  }
};

// Функция для безопасной отправки медиа группы
export const safeSendMediaGroup = async (
  bot: TelegramBot,
  chatId: number,
  media: TelegramBot.InputMedia[],
  options?: TelegramBot.SendMediaGroupOptions
): Promise<TelegramBot.Message[] | null> => {
  try {
    return await bot.sendMediaGroup(chatId, media, options);
  }
  catch (error: any) {
    const errorMessage = error && typeof error === "object" ? (error.message || String(error)) : String(error);

    if (errorMessage.includes("bot was blocked by the user") ||
        errorMessage.includes("user is deactivated") ||
        errorMessage.includes("chat not found") ||
        errorMessage.includes("ETELEGRAM: 403 Forbidden")) {

      return null;
    }

    throw error;
  }
};

// Функция для безопасного удаления сообщения
export const safeDeleteMessage = async (
  bot: TelegramBot,
  chatId: number,
  messageId: number
): Promise<boolean> => {
  try {
    return await bot.deleteMessage(chatId, messageId);
  }
  catch (error: any) {
    const errorMessage = error && typeof error === "object" ? (error.message || String(error)) : String(error);

    if (errorMessage.includes("bot was blocked by the user") ||
        errorMessage.includes("user is deactivated") ||
        errorMessage.includes("chat not found") ||
        errorMessage.includes("ETELEGRAM: 403 Forbidden")) {

      return false;
    }
    return false;
  }
};

export const downloadBuffer = async (url: string): Promise<Buffer> => {
  const response = await fetch(url);

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const size = parseInt(contentLength);
    const maxSize = 50 * 1024 * 1024;
    if (size > maxSize) {
      throw new FileTooLargeError(size);
    }
  }

  const arrayBuffer = await response.arrayBuffer();

  const maxSize = 50 * 1024 * 1024;
  if (arrayBuffer.byteLength > maxSize) {
    throw new FileTooLargeError(arrayBuffer.byteLength);
  }

  return Buffer.from(arrayBuffer);
};

export const isYoutubeShortsLink = (url: string): boolean => {
  return url.includes("youtube.com/shorts/") || url.includes("youtu.be/shorts/");
};

export const sendErrorToAdmin = async (
  bot: TelegramBot,
  error: any,
  context: string,
  userMessage?: string,
  chatId?: number,
  username?: string
) => {
  // Record error in database if we have user context
  if (chatId) {
    try {
      const errorMessage = typeof error === "object" && error !== null ? (error.message || JSON.stringify(error)) : String(error);
      recordError(chatId, context, errorMessage, userMessage, username);
    }
    catch (dbError) {
      console.error("Failed to record error in database:", dbError);
    }
  }

  if (error && typeof error === "object") {
    const errorMessage = error.message || String(error);

    if (errorMessage.includes("bot was blocked by the user") ||
        errorMessage.includes("user is deactivated") ||
        errorMessage.includes("chat not found") ||
        errorMessage.includes("ETELEGRAM: 403 Forbidden")) {
      return;
    }

    if (error instanceof FileTooLargeError) {
      return;
    }
  }
  const contextMessages: { [key: string]: string } = {
    "youtube download": "🎥 Ошибка загрузки YouTube Shorts",
    "youtube video send": "📤 Ошибка отправки YouTube видео",
    "youtube mp4 check": "🔍 YouTube не вернул ссылку на видео",
    "snapsave download": "📱 Ошибка скачивания из соцсетей",
    "media check": "📁 Не найдены медиафайлы в ответе",
    "single video": "🎬 Ошибка обработки одного видео",
    "single photo": "📸 Ошибка обработки одного фото",
    "sendMediaGroup videos": "🎥📦 Ошибка отправки группы видео",
    "sendMediaGroup photos": "📸📦 Ошибка отправки группы фото",
    "delete loading message": "🗑️ Не удалось удалить сообщение 'Загружаю...'",
    "main message handler": "⚙️ Общая ошибка обработки сообщения",
    "main function": "🚨 Критическая ошибка бота"
  };

  const contextTitle = contextMessages[context] || `❌ Ошибка: ${context}`;

  let errorDetails = "";
  if (typeof error === "object" && error !== null) {
    if (error.message) {
      errorDetails = error.message;
    }
    else if (error.error) {
      errorDetails = JSON.stringify(error.error, null, 2);
    }
    else {
      errorDetails = JSON.stringify(error, null, 2);
    }
  }
  else {
    errorDetails = String(error);
  }

  const userInfo = chatId ? `🚨 У пользователя ${username ? `@${username}` : `ID: ${chatId}`} произошла ошибка${userMessage ? ` при сообщении "${userMessage}"` : ""}` : "🚨 Системная ошибка бота";

  const errorMessage = [
    userInfo,
    "",
    contextTitle,
    "",
    "🔍 Детали ошибки:",
    errorDetails,
    "",
    ...(chatId ? [`👤 Chat ID: ${chatId}`, ""] : []),
    `⏰ Время: ${new Date().toLocaleString("ru-RU")}`
  ].join("\n");

  for (const adminId of ADMIN_USER_IDS) {
    try {
      await safeSendMessage(bot, adminId, errorMessage, {
        disable_notification: true
      });
    }
    catch (e) {
      console.warn(`Failed to send error to admin ${adminId}:`, e);
    }
  }
};

export const processSingleVideo = async (
  bot: TelegramBot,
  chatId: number,
  video: { url?: string },
  username?: string,
  loadingMsg?: TelegramBot.Message
): Promise<boolean> => {
  if (!video.url) {
    const result = await safeSendMessage(bot, chatId, "Не удалось получить URL видео.");
    if (result === null) {

      return false;
    }
    await sendErrorToAdmin(bot, "No video URL", "single video", undefined, chatId, username);
    return false;
  }

  try {
    const videoBuffer = await downloadBuffer(video.url);
    await safeSendVideo(bot, chatId, videoBuffer, { caption: BOT_TAG, disable_notification: true });
    return false;
  }
  catch (error: any) {
    if (error instanceof FileTooLargeError) {
      if (loadingMsg) {
        await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
      }
      await safeSendMessage(bot, chatId, "Слишком большой файл для загрузки. Максимальный размер: 50MB.");
      return true;
    }

    const errorMessage = error.message || String(error);
    if (errorMessage.includes("bot was blocked by the user") ||
        errorMessage.includes("user is deactivated") ||
        errorMessage.includes("chat not found") ||
        errorMessage.includes("ETELEGRAM: 403 Forbidden")) {

      return false;
    }
    await sendErrorToAdmin(bot, error, "single video", undefined, chatId, username);
    return false;
  }
};

export const processSinglePhoto = async (
  bot: TelegramBot,
  chatId: number,
  photo: { url?: string },
  username?: string,
  loadingMsg?: TelegramBot.Message
): Promise<boolean> => {
  if (!photo.url) {
    const result = await safeSendMessage(bot, chatId, "Не удалось получить URL фото.");
    if (result === null) {

      return false;
    }
    await sendErrorToAdmin(bot, "No photo URL", "single photo", undefined, chatId, username);
    return false;
  }

  try {
    const photoBuffer = await downloadBuffer(photo.url);
    await safeSendPhoto(bot, chatId, photoBuffer, { caption: BOT_TAG, disable_notification: true });
    return true;
  }
  catch (error: any) {
    if (error instanceof FileTooLargeError) {
      if (loadingMsg) {
        await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
      }
      await safeSendMessage(bot, chatId, "Слишком большой файл для загрузки. Максимальный размер: 50MB.");
      return true;
    }

    const errorMessage = error.message || String(error);
    if (errorMessage.includes("bot was blocked by the user") ||
        errorMessage.includes("user is deactivated") ||
        errorMessage.includes("chat not found") ||
        errorMessage.includes("ETELEGRAM: 403 Forbidden")) {
      return false;
    }
    await sendErrorToAdmin(bot, error, "single photo", undefined, chatId, username);
    return false;
  }
};

export const processMediaGroup = async (
  bot: TelegramBot,
  chatId: number,
  mediaItems: any[],
  mediaType: "video" | "photo",
  username?: string,
  loadingMsg?: TelegramBot.Message
): Promise<boolean> => {
  const validMedia = mediaItems.filter((item) =>
    item.url !== undefined && (item.type === "video" || item.type === "image")
  );
  if (validMedia.length === 0) return false;

  const mediaGroups: typeof validMedia[] = [];
  for (let i = 0; i < validMedia.length; i += 10) {
    mediaGroups.push(validMedia.slice(i, i + 10));
  }

  for (let groupIndex = 0; groupIndex < mediaGroups.length; groupIndex++) {
    const group = mediaGroups[groupIndex];
    const mediaBuffers: { buffer: Buffer, index: number }[] = [];

    try {
      for (let i = 0; i < group.length; i++) {
        const buffer = await downloadBuffer(group[i].url);
        mediaBuffers.push({ buffer, index: i });
      }

      const telegramMedia = mediaBuffers.map(({ buffer, index }) => ({
        type: mediaType,
        media: buffer as any,
        caption: index === 0 ? BOT_TAG : undefined
      }));

      await safeSendMediaGroup(bot, chatId, telegramMedia, {
        disable_notification: true
      });

      if (groupIndex < mediaGroups.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    catch (error: any) {
      if (error instanceof FileTooLargeError) {
        if (loadingMsg) {
          await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
        }
        await safeSendMessage(bot, chatId, "Один или несколько файлов слишком большие для загрузки. Максимальный размер: 50MB.");
        return true;
      }

      const errorMessage = error.message || String(error);
      if (errorMessage.includes("bot was blocked by the user") ||
          errorMessage.includes("user is deactivated") ||
          errorMessage.includes("chat not found") ||
          errorMessage.includes("ETELEGRAM: 403 Forbidden")) {
        return false;
      }
      await sendErrorToAdmin(bot, error, `sendMediaGroup ${mediaType}s`, undefined, chatId, username);
      return false;
    }
    finally {
      mediaBuffers.length = 0;
    }
  }
  return false;
};

export const processYouTubeShorts = async (bot: TelegramBot, chatId: number, message: string, username?: string, firstName?: string) => {
  const platform = detectPlatform(message);

  try {
    const response = await youtube(message);

    if (response && response.mp4) {
      const loadingMsg = await safeSendMessage(bot, chatId, "Загружаю...", {
        disable_notification: true
      });

      if (loadingMsg === null) {
        return;
      }

      try {
        const videoBuffer = await downloadBuffer(response.mp4);

        await safeSendVideo(bot, chatId, videoBuffer, {
          caption: BOT_TAG,
          disable_notification: true
        });

        await safeDeleteMessage(bot, chatId, loadingMsg.message_id);

        recordDownload(chatId, message, platform, "video", true, username, firstName);
      }
      catch (sendError: any) {
        if (sendError instanceof FileTooLargeError) {
          await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
          await safeSendMessage(bot, chatId, "Видео слишком большое для загрузки. Максимальный размер: 50MB.");
          recordDownload(chatId, message, platform, "video", false, username, firstName);
          return;
        }

        await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
        await safeSendMessage(bot, chatId, "Не удалось отправить видео с YouTube Shorts.");
        await sendErrorToAdmin(bot, sendError, "youtube video send", message, chatId, username);
        recordDownload(chatId, message, platform, "video", false, username, firstName);
      }
    }
    else {
      await safeSendMessage(bot, chatId, "Не удалось получить видео с YouTube Shorts.");
      await sendErrorToAdmin(bot, "No mp4 URL in YouTube response", "youtube mp4 check", message, chatId, username);
      recordDownload(chatId, message, platform, "video", false, username, firstName);
    }
  }
  catch (error) {
    await safeSendMessage(bot, chatId, "Не удалось скачать видео с YouTube Shorts. Попробуйте еще раз.");
    await sendErrorToAdmin(bot, error, "youtube download", message, chatId, username);
    recordDownload(chatId, message, platform, "video", false, username, firstName);
  }
};

const handleUnderlineEnding = (text: string): string => {
  if (text.endsWith("_")) {
    return text + "/";
  }
  return text;
};

export const processSocialMedia = async (bot: TelegramBot, chatId: number, message: string, username?: string, firstName?: string) => {
  const platform = detectPlatform(message);

  try {
    const formattedMessage = handleUnderlineEnding(message);
    const download = await snapsave(formattedMessage);

    if (!download.success) {
      await safeSendMessage(
        bot,
        chatId,
        `Не удалось скачать медиафайл.\nУбедитесь, что медиафайл существует и не является приватным.\nЕсли ошибка возникает многократно, пишите ${ADMIN_USERNAME}`
      );
      await sendErrorToAdmin(bot, download, "snapsave download", message, chatId, username);
      recordDownload(chatId, message, platform, "unknown", false, username, firstName);
      return;
    }

    const media = download.data?.media;
    if (!media) {
      await safeSendMessage(bot, chatId, "Не удалось скачать медиа. Попробуйте еще раз.");
      await sendErrorToAdmin(bot, "No media in response", "media check", message, chatId, username);
      recordDownload(chatId, message, platform, "unknown", false, username, firstName);
      return;
    }

    const videos = media.filter((m) => m.type === "video");
    const photos = media.filter((m) => m.type === "image");
    const loadingMsg = await safeSendMessage(bot, chatId, "Загружаю...", {
      disable_notification: true
    });

    if (loadingMsg === null) {
      return;
    }

    let hasSuccessfulDownload = false;
    let loadingMsgHandled = false;

    try {
      if (videos.length === 1) {
        loadingMsgHandled = await processSingleVideo(bot, chatId, videos[0], username, loadingMsg);
        hasSuccessfulDownload = !loadingMsgHandled;
      }
      else if (videos.length > 1) {
        loadingMsgHandled = await processMediaGroup(bot, chatId, videos, "video", username, loadingMsg);
        hasSuccessfulDownload = !loadingMsgHandled;
      }

      if (photos.length === 1 && !loadingMsgHandled) {
        const photoResult = await processSinglePhoto(bot, chatId, photos[0], username, loadingMsg);
        loadingMsgHandled = loadingMsgHandled || photoResult;
        hasSuccessfulDownload = hasSuccessfulDownload || !photoResult;
      }
      else if (photos.length > 1 && !loadingMsgHandled) {
        const photoResult = await processMediaGroup(bot, chatId, photos, "photo", username, loadingMsg);
        loadingMsgHandled = loadingMsgHandled || photoResult;
        hasSuccessfulDownload = hasSuccessfulDownload || !photoResult;
      }

      if (hasSuccessfulDownload) {
        recordDownload(chatId, message, platform, videos.length > 0 ? "video" : "photo", true, username, firstName);

        if (!loadingMsgHandled) {
          await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
        }
      }
      else {
        if (!loadingMsgHandled) {
          await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
        }
      }

    }
    catch (error: any) {
      if (error instanceof FileTooLargeError) {
        if (!loadingMsgHandled) {
          await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
        }
        await safeSendMessage(bot, chatId, "Файл слишком большой для загрузки. Максимальный размер: 50MB.");
        recordDownload(chatId, message, platform, "unknown", false, username, firstName);
        return;
      }

      if (!loadingMsgHandled) {
        await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
      }
      recordDownload(chatId, message, platform, "unknown", false, username, firstName);
      await sendErrorToAdmin(bot, error, "main message handler", message, chatId, username);
    }
  }
  catch (error) {
    await safeSendMessage(bot, chatId, "Произошла ошибка при обработке запроса.");
    await sendErrorToAdmin(bot, error, "snapsave download", message, chatId, username);
    recordDownload(chatId, message, platform, "unknown", false, username, firstName);
  }
};

export const shutdown = async (signal: string, bot: TelegramBot) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);

  try {
    await bot.stopPolling();
    console.log("Bot stopped polling");

    closeDatabase();
    console.log("Database closed");

    process.exit(0);
  }
  catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
};


export const helpMessage = [
  "Отправьте ссылку на видео для скачивания.",
  "",
  "Поддерживаемые платформы:",
  "• TikTok",
  "• Instagram (рилсы, посты, сторис)",
  "• Facebook (видео)",
  "• Twitter (X) (картинки и видео)",
  "• YouTube Shorts",
  "",
  "Пример: https://www.instagram.com/reel/DKKPO_gyGAg/?igsh=ejVqOTBpNm85OHA0",
  "",
  BOT_TAG
].join("\n");