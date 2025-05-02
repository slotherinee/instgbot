import TelegramBot from "node-telegram-bot-api";
import { snapsave } from "./snapsave";
import { randomUUID } from "crypto";
import { access, mkdir, unlink, writeFile } from "fs/promises";
import { join } from "path";


const token = Bun.env.TELEGRAM_BOT!;
const bot = new TelegramBot(token, { polling: true });
const ADMIN_CHAT_ID = Bun.env.ADMIN_CHAT_ID!;
const BOT_TAG = "@instg_save_bot";

const baseDir = process.cwd();
const mediaPath = join(baseDir, "media");

const sendErrorToAdmin = async (error: any, context: string) => {
  const errorMessage = `❌ Error in ${context}:\n${error.message || error}\n\nStack: ${error.stack || "No stack trace"}`;
  try {
    await bot.sendMessage(ADMIN_CHAT_ID, errorMessage);
  }
  catch (e) {
    console.warn("Failed to send error to admin:", e);
  }
};

const checkMediaFolder = async () => {
  try {
    await access(mediaPath);
    console.info("Media folder found at:", mediaPath);
  }
  catch {
    console.info("Creating media folder at:", mediaPath);
    await mkdir(mediaPath, { recursive: true });
  }
};

const saveTempFile = async (buffer: Buffer, extension: string): Promise<string> => {
  const filename = `${randomUUID()}.${extension}`;
  const filepath = join(mediaPath, filename);
  await writeFile(filepath, buffer);
  return filepath;
};

const cleanupFile = async (filepath: string) => {
  try {
    await unlink(filepath);
  }
  catch (error) {
    console.warn("Error cleaning up file:", error);
    await sendErrorToAdmin(error, "cleanupFile");
  }
};

const main = async () => {
  try {
    await checkMediaFolder();
    console.info("Bot started");

    bot.onText(/\/start/, (msg) => {
      bot.sendMessage(msg.chat.id, "Привет! Я бот для скачивания медиа из TikTok и Instagram. Отправь мне ссылку на видео или фото, и я скачаю его для тебя." + "\n\n" + "По всем вопросам @void_0x");
      return;
    });

    bot.on("text", async (msg) => {
      const chatId = msg.chat.id;
      const message = msg.text;

      if (message === "/start") return;
      if (message &&!message.includes("https://") && message.length < 10) {
        await bot.sendMessage(chatId, "Неверная ссылка. Попробуйте еще раз.");
        return;
      }

      try {
        const download = await snapsave(message && message.trim() !== "" ? message : "");
        if (!download.success) {
          await bot.sendMessage(chatId, "Не удалось скачать медиафайл." + "\n" + "Если ошибка возникает многократно, пишите @void_0x");
          await sendErrorToAdmin({
            error: download,
            message: message,
            chatId: chatId
          }, "snapsave download");
          return;
        }

        const media = download.data?.media;
        if (!media) {
          await bot.sendMessage(chatId, "Не удалось скачать медиа. Попробуйте еще раз.");
          await sendErrorToAdmin("No media in response", "media check");
          return;
        }

        const videos = media.filter((m) => m.type === "video");
        const photos = media.filter((m) => m.type === "image");

        const loadingMsg = await bot.sendMessage(chatId, "Загружаю...");

        try {
          if (videos.length === 1) {
            const video = videos[0];
            if (!video.url) {
              await bot.sendMessage(chatId, "Не удалось получить URL видео.");
              await sendErrorToAdmin("No video URL", "single video");
              return;
            }
            const videoResponse = await fetch(video.url);
            const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
            const videoPath = await saveTempFile(videoBuffer, "mp4");

            try {
              await bot.sendVideo(chatId, videoPath, {
                caption: BOT_TAG
              });
            }
            finally {
              await cleanupFile(videoPath);
            }
          }
          else if (videos.length > 1) {
            const validVideos = videos.filter((video): video is { url: string, type: "video" } =>
              video.url !== undefined && video.type === "video"
            );

            if (validVideos.length > 0) {
              const videoPaths: string[] = [];

              try {
                for (const video of validVideos) {
                  const videoResponse = await fetch(video.url);
                  const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
                  const videoPath = await saveTempFile(videoBuffer, "mp4");
                  videoPaths.push(videoPath);
                }

                await bot.sendMediaGroup(chatId, videoPaths.map((path, index) => ({
                  type: "video",
                  media: path,
                  caption: index === 0 ? BOT_TAG : undefined
                })));
              }
              finally {
                await Promise.all(videoPaths.map(cleanupFile));
              }
            }
          }

          if (photos.length === 1) {
            const photo = photos[0];
            if (!photo.url) {
              await bot.sendMessage(chatId, "Не удалось получить URL фото.");
              await sendErrorToAdmin("No photo URL", "single photo");
              return;
            }
            const photoResponse = await fetch(photo.url);
            const photoBuffer = Buffer.from(await photoResponse.arrayBuffer());
            const photoPath = await saveTempFile(photoBuffer, "jpg");

            try {
              await bot.sendPhoto(chatId, photoPath, {
                caption: BOT_TAG
              });
            }
            finally {
              await cleanupFile(photoPath);
            }
          }
          else if (photos.length > 1) {
            const validPhotos = photos.filter((photo): photo is { url: string, type: "image" } =>
              photo.url !== undefined && photo.type === "image"
            );

            if (validPhotos.length > 0) {
              const photoPaths: string[] = [];

              try {
                for (const photo of validPhotos) {
                  const photoResponse = await fetch(photo.url);
                  const photoBuffer = Buffer.from(await photoResponse.arrayBuffer());
                  const photoPath = await saveTempFile(photoBuffer, "jpg");
                  photoPaths.push(photoPath);
                }

                await bot.sendMediaGroup(chatId, photoPaths.map((path, index) => ({
                  type: "photo",
                  media: path,
                  caption: index === 0 ? BOT_TAG : undefined
                })));
              }
              finally {
                await Promise.all(photoPaths.map(cleanupFile));
              }
            }
          }
        }
        finally {
          try {
            await bot.deleteMessage(chatId, loadingMsg.message_id);
          }
          catch (error) {
            console.error("Error deleting loading message:", error);
            await sendErrorToAdmin(error, "delete loading message");
          }
        }
      }
      catch (error) {
        await sendErrorToAdmin(error, "main message handler");
        await bot.sendMessage(chatId, "Произошла ошибка при обработке запроса.");
      }
    });
  }
  catch (error) {
    await sendErrorToAdmin(error, "main function");
    process.exit(1);
  }
};

export default main;