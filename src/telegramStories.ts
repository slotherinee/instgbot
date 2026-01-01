import TelegramBot from "node-telegram-bot-api";
import { BOT_TAG, FileTooLargeError, safeSendMediaGroup, safeSendMessage, sendErrorToAdmin } from "./utils";
import { Api } from "telegram";
import { recordDownload } from "./database";

export async function downloadStories ({
  userClient,
  bot,
  username,
  chatId
}: {
  userClient: any;
  bot: TelegramBot;
  username: string;
  chatId: number;
}): Promise<boolean> {
  let loadingMsg: TelegramBot.Message | null = null;
  try {
    loadingMsg = await safeSendMessage(bot, chatId, "Загружаю сторис...", { disable_notification: true });
    const peer = await userClient.getEntity(username);
    const result = await userClient.invoke(
      new Api.stories.GetPeerStories({ peer })
    );

    if (!result.stories || result.stories.stories.length === 0) {
      await safeSendMessage(bot, chatId, `Не удалось найти публичные сторис у @${username}. Возможно, пользователь скрыл свои сторис или у него нет публичных сторис.\n${BOT_TAG}`);
      if (loadingMsg) await bot.deleteMessage(chatId, loadingMsg.message_id);
      return false;
    }

    let successCount = 0;
    const photos: any[] = [];
    const videos: any[] = [];

    for (const story of result.stories.stories) {
      if (!("media" in story) || !story.media) continue;
      let fileBuffer: Buffer | undefined;
      try {
        const mediaResult = await userClient.downloadMedia(story.media);
        if (Buffer.isBuffer(mediaResult)) {
          fileBuffer = mediaResult;
        }
        else {
          continue;
        }
      }
      catch (e: any) {
        if (e instanceof FileTooLargeError) {
          await safeSendMessage(bot, chatId, `Сторис слишком большой для загрузки (максимум 50MB).\n${BOT_TAG}`);
        }
        else {
          await sendErrorToAdmin(bot, e, "telegram stories download", undefined, chatId, username);
        }
        continue;
      }
      if (!fileBuffer) continue;
      const mediaClassName = ("className" in story.media) ? story.media.className : "";
      if (mediaClassName === "MessageMediaPhoto") {
        photos.push({ type: "photo", media: fileBuffer });
        successCount++;
      }
      else if (mediaClassName === "MessageMediaDocument") {
        videos.push({ type: "video", media: fileBuffer });
        successCount++;
      }
    }

    if (photos.length > 0) {
      try {
        const mediaWithCaption = photos.map((item, idx) => idx === 0 ? { ...item, caption: BOT_TAG } : item);
        await safeSendMediaGroup(bot, chatId, mediaWithCaption);
      }
      catch (e) {
        await sendErrorToAdmin(bot, e, "sendMediaGroup photos", undefined, chatId, username);
      }
      photos.length = 0;
    }
    if (videos.length > 0) {
      try {
        const mediaWithCaption = videos.map((item, idx) => idx === 0 ? { ...item, caption: BOT_TAG } : item);
        await safeSendMediaGroup(bot, chatId, mediaWithCaption);
      }
      catch (e) {
        await sendErrorToAdmin(bot, e, "sendMediaGroup videos", undefined, chatId, username);
      }
      videos.length = 0;
    }
    if (successCount === 0) {
      await safeSendMessage(bot, chatId, `Сторис найдены, но не удалось загрузить медиа. Возможно, они недоступны.\n${BOT_TAG}`);
      if (loadingMsg) await bot.deleteMessage(chatId, loadingMsg.message_id);
      return false;
    }
    if (loadingMsg) await bot.deleteMessage(chatId, loadingMsg.message_id);
    try {
      await recordDownload(chatId, username, "telegram", "story", true, username);
    }
    catch (e) {
      console.error("Ошибка записи сторис в БД:", e);
    }
    return true;
  }
  catch (error: any) {
    if (loadingMsg) await bot.deleteMessage(chatId, loadingMsg.message_id);
    await safeSendMessage(bot, chatId, `Ошибка при загрузке сторис. Попробуйте позже.\n${BOT_TAG}`);
    await sendErrorToAdmin(bot, error, "telegram stories download", undefined, chatId, username);
    return false;
  }
}
