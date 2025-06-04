import TelegramBot from "node-telegram-bot-api";
import { snapsave } from "snapsave-media-downloader";
import { youtube } from "btch-downloader";

const token = Bun.env.TELEGRAM_BOT!;
Bun.env.NTBA_FIX_350 = "1";
const bot = new TelegramBot(token, { polling: true });
const ADMIN_CHAT_ID = Bun.env.ADMIN_CHAT_ID!;
const BOT_TAG = "@instg_save_bot";
const ADMIN_USERNAME = "@jullieem";

const sendErrorToAdmin = async (error: any, context: string, userMessage?: string, chatId?: number, username?: string) => {
  if (!ADMIN_CHAT_ID) {
    console.error("ADMIN_CHAT_ID is not set. Cannot send error report.");
    return;
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

  try {
    await bot.sendMessage(ADMIN_CHAT_ID, errorMessage);
  }
  catch (e) {
    console.warn("Failed to send error to admin:", e);
  }
};

const downloadBuffer = async (url: string): Promise<Buffer> => {
  const response = await fetch(url);
  return Buffer.from(await response.arrayBuffer());
};

const processSingleVideo = async (chatId: number, video: { url?: string }, username?: string) => {
  if (!video.url) {
    await bot.sendMessage(chatId, "Не удалось получить URL видео.");
    await sendErrorToAdmin("No video URL", "single video", undefined, chatId, username);
    return;
  }

  const videoBuffer = await downloadBuffer(video.url);
  await bot.sendVideo(chatId, videoBuffer, { caption: BOT_TAG });
};

const processSinglePhoto = async (chatId: number, photo: { url?: string }, username?: string) => {
  if (!photo.url) {
    await bot.sendMessage(chatId, "Не удалось получить URL фото.");
    await sendErrorToAdmin("No photo URL", "single photo", undefined, chatId, username);
    return;
  }

  const photoBuffer = await downloadBuffer(photo.url);
  await bot.sendPhoto(chatId, photoBuffer, { caption: BOT_TAG });
};

const processMediaGroup = async (
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
      await sendErrorToAdmin(error, `sendMediaGroup ${mediaType}s`, undefined, chatId, username);
    }
    finally {
      mediaBuffers.length = 0;
    }
  }
};

const processYouTubeShorts = async (chatId: number, message: string, username?: string) => {
  try {
    const response = await youtube(message);

    if (response && response.mp4) {
      const loadingMsg = await bot.sendMessage(chatId, "Загружаю видео с YouTube...");

      try {
        const videoBuffer = await downloadBuffer(response.mp4);

        await bot.sendVideo(chatId, videoBuffer, {
          caption: `${response.title || "YouTube Shorts"}\n\n${BOT_TAG}`
        });

        await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      }
      catch (sendError) {
        await bot.sendMessage(chatId, "Не удалось отправить видео с YouTube Shorts.");
        await sendErrorToAdmin(sendError, "youtube video send", message, chatId, username);
      }
    }
    else {
      await bot.sendMessage(chatId, "Не удалось получить видео с YouTube Shorts.");
      await sendErrorToAdmin("No mp4 URL in YouTube response", "youtube mp4 check", message, chatId, username);
    }
  }
  catch (error) {
    await bot.sendMessage(chatId, "Не удалось скачать видео с YouTube Shorts. Попробуйте еще раз.");
    await sendErrorToAdmin(error, "youtube download", message, chatId, username);
  }
};

const processSocialMedia = async (chatId: number, message: string, username?: string) => {
  try {
    const download = await snapsave(message);

    if (!download.success) {
      await bot.sendMessage(
        chatId,
        `Не удалось скачать медиафайл.\nЕсли ошибка возникает многократно, пишите ${ADMIN_USERNAME}`
      );
      await sendErrorToAdmin(download, "snapsave download", message, chatId, username);
      return;
    }

    const media = download.data?.media;
    if (!media) {
      await bot.sendMessage(chatId, "Не удалось скачать медиа. Попробуйте еще раз.");
      await sendErrorToAdmin("No media in response", "media check", message, chatId, username);
      return;
    }

    const videos = media.filter((m) => m.type === "video");
    const photos = media.filter((m) => m.type === "image");

    const loadingMsg = await bot.sendMessage(chatId, "Загружаю...");

    try {
      if (videos.length === 1) {
        await processSingleVideo(chatId, videos[0], username);
      }
      else if (videos.length > 1) {
        await processMediaGroup(chatId, videos, "video", username);
      }

      if (photos.length === 1) {
        await processSinglePhoto(chatId, photos[0], username);
      }
      else if (photos.length > 1) {
        await processMediaGroup(chatId, photos, "photo", username);
      }
    }
    finally {
      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    }
  }
  catch (error) {
    await bot.sendMessage(chatId, "Произошла ошибка при обработке запроса.");
    await sendErrorToAdmin(error, "main message handler", message, chatId, username);
  }
};

const isYoutubeShortsLink = (url: string): boolean => {
  return url.includes("youtube.com/shorts/") || url.includes("youtu.be/shorts/");
};

const main = async () => {
  try {
    console.info("Bot started");

    bot.onText(/\/start/, (msg) => {
      bot.sendMessage(
        msg.chat.id,
        "Привет! Я бот для скачивания медиа из TikTok, Twitter, Youtube Shorts, Facebook и Instagram. " +
        "Отправь мне ссылку на видео или фото, и я скачаю его для тебя.\n\n" +
        `По всем вопросам ${ADMIN_USERNAME}`
      );
    });

    bot.on("text", async (msg) => {
      const chatId = msg.chat.id;
      const message = msg.text;
      const username = msg.from?.username || msg.from?.first_name || "У пользователя нет юзернейма";

      if (message === "/start") return;

      if (!message || !message.includes("https://")) {
        await bot.sendMessage(chatId, "Неверная ссылка. Попробуйте еще раз.");
        return;
      }

      if (isYoutubeShortsLink(message)) {
        await processYouTubeShorts(chatId, message, username);
        return;
      }

      await processSocialMedia(chatId, message, username);
    });
  }
  catch (error) {
    await sendErrorToAdmin(error, "main function");
    process.exit(1);
  }
};

export default main;