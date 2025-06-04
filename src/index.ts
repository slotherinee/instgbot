import TelegramBot from "node-telegram-bot-api";
import { snapsave } from "snapsave-media-downloader";
import { youtube } from "btch-downloader";

const token = Bun.env.TELEGRAM_BOT!;
Bun.env.NTBA_FIX_350 = "1";
const bot = new TelegramBot(token, { polling: true });
const ADMIN_CHAT_ID = Bun.env.ADMIN_CHAT_ID!;
const BOT_TAG = "@instg_save_bot";
const ADMIN_USERNAME = "@jullieem";

const sendErrorToAdmin = async (error: any, context: string) => {
  const errorMessage = `❌ Error in ${context}:\n${error.message || error}\n\nStack: ${error.stack || "No stack trace"}`;
  try {
    await bot.sendMessage(ADMIN_CHAT_ID, errorMessage);
  }
  catch (e) {
    console.warn("Failed to send error to admin:", e);
  }
};

const isYoutubeShortsLink = (url: string): boolean => {
  return url.includes("youtube.com/shorts/") || url.includes("youtu.be/shorts/");
};

const main = async () => {
  try {
    console.info("Bot started");

    bot.onText(/\/start/, (msg) => {
      bot.sendMessage(msg.chat.id, "Привет! Я бот для скачивания медиа из TikTok, Twitter, Youtube Shorts, Facebook и Instagram. Отправь мне ссылку на видео или фото, и я скачаю его для тебя." + "\n\n" + "По всем вопросам " + ADMIN_USERNAME);
      return;
    });

    bot.on("text", async (msg) => {
      const chatId = msg.chat.id;
      const message = msg.text;

      if (message === "/start") return;
      if (message && !message.includes("https://")) {
        await bot.sendMessage(chatId, "Неверная ссылка. Попробуйте еще раз.");
        return;
      }
      let isShorts = false;
      if (message && message.trim() !== "" && isYoutubeShortsLink(message)) {
        isShorts = true;
      }

      if (isShorts) {
        try {
          const response = await youtube(message);

          if (response && response.mp4) {
            const loadingMsg = await bot.sendMessage(chatId, "Загружаю...");

            try {
              const videoResponse = await fetch(response.mp4);
              const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

              await bot.sendVideo(chatId, videoBuffer, {
                caption: BOT_TAG
              });

              try {
                await bot.deleteMessage(chatId, loadingMsg.message_id);
              }
              catch (deleteError) {
                console.warn("Could not delete loading message:", deleteError);
              }

            }
            catch (sendError) {
              console.error("Error sending YouTube video:", sendError);
              await bot.sendMessage(chatId, "Не удалось отправить видео с YouTube Shorts.");
              await sendErrorToAdmin(sendError, "youtube video send");
            }
          }
          else {
            await bot.sendMessage(chatId, "Не удалось получить видео с YouTube Shorts.");
            await sendErrorToAdmin("No mp4 URL in YouTube response", "youtube mp4 check");
          }
        }
        catch (error) {
          console.error("Error fetching YouTube data:", error);
          await bot.sendMessage(chatId, "Не удалось скачать видео с YouTube Shorts. Попробуйте еще раз.");
          await sendErrorToAdmin(error, "youtube download");
          return;
        }
        finally {
          isShorts = false;
          return;
        }
      }

      try {
        const download = await snapsave(message && message.trim() !== "" ? message : "");
        if (!download.success) {
          await bot.sendMessage(chatId, "Не удалось скачать медиафайл." + "\n" + "Если ошибка возникает многократно, пишите " + ADMIN_USERNAME);
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

            try {
              await bot.sendVideo(chatId, videoBuffer, {
                caption: BOT_TAG
              });
            }
            finally {
            }
          }
          else if (videos.length > 1) {
            const validVideos = videos.filter((video): video is { url: string, type: "video" } =>
              video.url !== undefined && video.type === "video"
            );

            if (validVideos.length > 0) {
              try {
                const videoGroups: typeof validVideos[] = [];
                for (let i = 0; i < validVideos.length; i += 10) {
                  videoGroups.push(validVideos.slice(i, i + 10));
                }

                for (let groupIndex = 0; groupIndex < videoGroups.length; groupIndex++) {
                  const videoGroup = videoGroups[groupIndex];
                  let mediaBuffers: { buffer: Buffer, index: number }[] = [];

                  try {
                    for (let i = 0; i < videoGroup.length; i++) {
                      const video = videoGroup[i];
                      const videoResponse = await fetch(video.url);
                      const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
                      mediaBuffers.push({ buffer: videoBuffer, index: i });
                    }

                    const media: TelegramBot.InputMediaVideo[] = mediaBuffers.map(({ buffer, index }) => ({
                      type: "video",
                      media: buffer as any,
                      caption: index === 0 && groupIndex === 0 ? BOT_TAG : undefined
                    }));

                    // Отправляем группу
                    await bot.sendMediaGroup(chatId, media);

                    if (groupIndex < videoGroups.length - 1) {
                      await new Promise(resolve => setTimeout(resolve, 500));
                    }
                  }
                  finally {
                    if (mediaBuffers.length > 0) {
                      mediaBuffers.length = 0;
                    }
                  }
                }
              }
              catch (error) {
                console.error("Error sending video media groups:", error);
                await sendErrorToAdmin(error, "sendMediaGroup videos");
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

            try {
              await bot.sendPhoto(chatId, photoBuffer, {
                caption: BOT_TAG
              });
            }
            finally {
            }
          }
          else if (photos.length > 1) {
            const validPhotos = photos.filter((photo): photo is { url: string, type: "image" } =>
              photo.url !== undefined && photo.type === "image"
            );

            if (validPhotos.length > 0) {
              try {
                const photoGroups: typeof validPhotos[] = [];
                for (let i = 0; i < validPhotos.length; i += 10) {
                  photoGroups.push(validPhotos.slice(i, i + 10));
                }

                for (let groupIndex = 0; groupIndex < photoGroups.length; groupIndex++) {
                  const photoGroup = photoGroups[groupIndex];
                  let mediaBuffers: { buffer: Buffer, index: number }[] = [];

                  try {
                    for (let i = 0; i < photoGroup.length; i++) {
                      const photo = photoGroup[i];
                      const photoResponse = await fetch(photo.url);
                      const photoBuffer = Buffer.from(await photoResponse.arrayBuffer());
                      mediaBuffers.push({ buffer: photoBuffer, index: i });
                    }

                    const media: TelegramBot.InputMediaPhoto[] = mediaBuffers.map(({ buffer, index }) => ({
                      type: "photo",
                      media: buffer as any,
                      caption: index === 0 && groupIndex === 0 ? BOT_TAG : undefined
                    }));

                    await bot.sendMediaGroup(chatId, media);

                    if (groupIndex < photoGroups.length - 1) {
                      await new Promise(resolve => setTimeout(resolve, 500));
                    }
                  }
                  finally {
                    if (mediaBuffers.length > 0) {
                      mediaBuffers.length = 0;
                    }
                  }
                }
              }
              catch (error) {
                console.error("Error sending photo media groups:", error);
                await sendErrorToAdmin(error, "sendMediaGroup photos");
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