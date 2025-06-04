import TelegramBot from "node-telegram-bot-api";
import { snapsave } from "snapsave-media-downloader";
import { youtube } from "btch-downloader";
import { closeDatabase, detectPlatform, recordDownload } from "./database";

export const BOT_TAG = "@instg_save_bot";
export const ADMIN_USERNAME = Bun.env.ADMIN_USERNAME!;
export const ADMIN_USER_IDS = [324025710, 542142955];

export const isAdmin = (userId?: number): boolean => {
  if (!userId) return false;
  return ADMIN_USER_IDS.includes(userId);
};

export const downloadBuffer = async (url: string): Promise<Buffer> => {
  const response = await fetch(url);
  return Buffer.from(await response.arrayBuffer());
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
      await bot.sendMessage(adminId, errorMessage);
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
  username?: string
) => {
  if (!video.url) {
    await bot.sendMessage(chatId, "Не удалось получить URL видео.");
    await sendErrorToAdmin(bot, "No video URL", "single video", undefined, chatId, username);
    return;
  }

  const videoBuffer = await downloadBuffer(video.url);
  await bot.sendVideo(chatId, videoBuffer, { caption: BOT_TAG });
};

export const processSinglePhoto = async (
  bot: TelegramBot,
  chatId: number,
  photo: { url?: string },
  username?: string
) => {
  if (!photo.url) {
    await bot.sendMessage(chatId, "Не удалось получить URL фото.");
    await sendErrorToAdmin(bot, "No photo URL", "single photo", undefined, chatId, username);
    return;
  }

  const photoBuffer = await downloadBuffer(photo.url);
  await bot.sendPhoto(chatId, photoBuffer, { caption: BOT_TAG });
};

export const processMediaGroup = async (
  bot: TelegramBot,
  chatId: number,
  mediaItems: any[],
  mediaType: "video" | "photo",
  username?: string
) => {
  const validMedia = mediaItems.filter((item) =>
    item.url !== undefined && item.type === mediaType
  );

  if (validMedia.length === 0) return;

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
        caption: index === 0 && groupIndex === 0 ? BOT_TAG : undefined
      }));

      await bot.sendMediaGroup(chatId, telegramMedia);

      if (groupIndex < mediaGroups.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    catch (error) {
      await sendErrorToAdmin(bot, error, `sendMediaGroup ${mediaType}s`, undefined, chatId, username);
    }
    finally {
      mediaBuffers.length = 0;
    }
  }
};

export const processYouTubeShorts = async (bot: TelegramBot, chatId: number, message: string, username?: string, firstName?: string) => {
  const platform = detectPlatform(message);

  try {
    const response = await youtube(message);

    if (response && response.mp4) {
      const loadingMsg = await bot.sendMessage(chatId, "Загружаю...");

      try {
        const videoBuffer = await downloadBuffer(response.mp4);

        await bot.sendVideo(chatId, videoBuffer, {
          caption: BOT_TAG
        });

        await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

        recordDownload(chatId, message, platform, "video", true);
      }
      catch (sendError) {
        await bot.sendMessage(chatId, "Не удалось отправить видео с YouTube Shorts.");
        await sendErrorToAdmin(bot, sendError, "youtube video send", message, chatId, username);
        recordDownload(chatId, message, platform, "video", false);
      }
    }
    else {
      await bot.sendMessage(chatId, "Не удалось получить видео с YouTube Shorts.");
      await sendErrorToAdmin(bot, "No mp4 URL in YouTube response", "youtube mp4 check", message, chatId, username);
      recordDownload(chatId, message, platform, "video", false);
    }
  }
  catch (error) {
    await bot.sendMessage(chatId, "Не удалось скачать видео с YouTube Shorts. Попробуйте еще раз.");
    await sendErrorToAdmin(bot, error, "youtube download", message, chatId, username);
    recordDownload(chatId, message, platform, "video", false);
  }
};

export const processSocialMedia = async (bot: TelegramBot, chatId: number, message: string, username?: string, firstName?: string) => {
  const platform = detectPlatform(message);

  try {
    const download = await snapsave(message);

    if (!download.success) {
      await bot.sendMessage(
        chatId,
        `Не удалось скачать медиафайл.\nЕсли ошибка возникает многократно, пишите ${ADMIN_USERNAME}`
      );
      await sendErrorToAdmin(bot, download, "snapsave download", message, chatId, username);
      recordDownload(chatId, message, platform, "unknown", false);
      return;
    }

    const media = download.data?.media;
    if (!media) {
      await bot.sendMessage(chatId, "Не удалось скачать медиа. Попробуйте еще раз.");
      await sendErrorToAdmin(bot, "No media in response", "media check", message, chatId, username);
      recordDownload(chatId, message, platform, "unknown", false);
      return;
    }

    const videos = media.filter((m) => m.type === "video");
    const photos = media.filter((m) => m.type === "image");

    const loadingMsg = await bot.sendMessage(chatId, "Загружаю...");

    let hasSuccessfulDownload = false;

    try {
      if (videos.length === 1 && photos.length === 0) {
        await processSingleVideo(bot, chatId, videos[0], username);
        hasSuccessfulDownload = true;
      }
      else if (photos.length === 1 && videos.length === 0) {
        await processSinglePhoto(bot, chatId, photos[0], username);
        hasSuccessfulDownload = true;
      }
      else {
        if (videos.length > 0) {
          await processMediaGroup(bot, chatId, videos, "video", username);
          hasSuccessfulDownload = true;
        }
        if (photos.length > 0) {
          await processMediaGroup(bot, chatId, photos, "photo", username);
          hasSuccessfulDownload = true;
        }
      }

      if (hasSuccessfulDownload) {
        recordDownload(chatId, message, platform, videos.length > 0 ? "video" : "image", true);

        await bot.deleteMessage(chatId, loadingMsg.message_id).catch(async (error) => {
          await sendErrorToAdmin(bot, error, "delete loading message", message, chatId, username);
        });
      }

    }
    catch (error) {
      recordDownload(chatId, message, platform, "unknown", false);
      await sendErrorToAdmin(bot, error, "main message handler", message, chatId, username);
    }
  }
  catch (error) {
    await bot.sendMessage(chatId, "Произошла ошибка при обработке запроса.");
    await sendErrorToAdmin(bot, error, "snapsave download", message, chatId, username);
    recordDownload(chatId, message, platform, "unknown", false);
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
