import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import type TelegramBot from "node-telegram-bot-api";
import { InputFile } from "grammy";
import { CustomFile } from "telegram/client/uploads";
import { BOT_TAG } from "../config";
import { grammyApi, withChatAction } from "../bot/safe-send";
import { safeSendMessage } from "../bot/safe-send";
import { sendErrorToAdmin } from "../bot/errors";
import { checkYouTubeRateLimit } from "../bot/rate-limit";
import { getCachedFileId, setCachedFileId } from "../db/queries";
import { getBotMtproto } from "../bot/mtproto";
import { Api } from "telegram";

const GRAMMY_LIMIT_MB = 50;
const YT_DLP = process.env.YT_DLP_PATH ?? "yt-dlp";
const STATIC_VIDEO_QUALITIES = [144, 240, 360, 480, 720];

const ytDlp = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const proc = spawn(YT_DLP, args);
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    proc.on("close", code => code === 0 ? resolve(out) : reject(new Error(err || `yt-dlp exit ${code}`)));
  });

const ytDlpStream = (args: string[]): Readable => {
  const proc = spawn(YT_DLP, args);
  return proc.stdout as unknown as Readable;
};

const mkfifo = (path: string): Promise<void> =>
  new Promise((res, rej) =>
    spawn("mkfifo", [path]).on("close", code => code === 0 ? res() : rej(new Error(`mkfifo exit ${code}`)))
  );

// Returns selected format info after yt-dlp applies the format selector
const getFormatInfo = async (url: string, fmtStr: string): Promise<{ formatId: string, sizeBytes: number, sizeMB: number, title: string, height: number }> => {
  const raw = await ytDlp(["--dump-json", "--no-playlist", "--no-cache-dir", "-f", fmtStr, url]);
  const info = JSON.parse(raw);
  const sizeBytes: number = info.filesize ?? 0;
  const sizeMB = sizeBytes? Math.round(sizeBytes / 1024 / 1024): info.filesize_approx? Math.round(info.filesize_approx / 1024 / 1024): 0;
  return {
    formatId: info.format_id,
    sizeBytes,
    sizeMB,
    title: info.title ?? "YouTube видео",
    height: info.height ?? 0
  };
};

type PendingDownload = { url: string };

export const pendingYouTube = new Map<number, PendingDownload>();

export const sendYouTubeQualityPicker = async (
  bot: TelegramBot,
  chatId: number,
  url: string,
  username?: string
) => {
  try {
    pendingYouTube.set(chatId, { url });
    setTimeout(() => pendingYouTube.delete(chatId), 5 * 60 * 1000);

    const videoButtons = STATIC_VIDEO_QUALITIES.map(q => {
      const cached = getCachedFileId(url, `yt_v_${q}`) ? "⚡ " : "";
      return [{ text: `${cached}🎬 ${q}p`, callback_data: `yt:${chatId}:v:${q}` }];
    });
    const audioCached = getCachedFileId(url, "yt_a_best") ? "⚡ " : "";

    await bot.sendMessage(chatId, "🎬 <b>YouTube видео</b>\n\nВыберите формат:\n<i>Максимум в Telegram — 2 ГБ</i>", {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          ...videoButtons,
          [{ text: `${audioCached}🎵 Аудио`, callback_data: `yt:${chatId}:a:0` }]
        ]
      }
    });
  }
  catch (error) {
    await safeSendMessage(bot, chatId, "Не удалось отправить меню.");
    await sendErrorToAdmin(bot, error, "youtube quality picker", url, chatId, username);
  }
};

export const handleYouTubeCallback = async (
  bot: TelegramBot,
  chatId: number,
  type: "v" | "a",
  quality: number,
  userId: number,
  username?: string
) => {
  const rateLimit = checkYouTubeRateLimit(userId);
  if (!rateLimit.allowed) {
    const sec = Math.ceil((rateLimit.resetTime - Date.now()) / 1000);
    await safeSendMessage(bot, chatId, `⚡ Лимит: 1 загрузка в 3 минуты. Повторите через ${sec} сек.`);
    return;
  }

  const pending = pendingYouTube.get(chatId);
  if (!pending) {
    await safeSendMessage(bot, chatId, "Сессия истекла. Отправьте ссылку заново.");
    return;
  }

  pendingYouTube.delete(chatId);
  const { url } = pending;

  const cacheKey = url;
  const cacheType = type === "a" ? "yt_a_best" : `yt_v_${quality}`;
  const fmtStr = type === "a"? "bestaudio[ext=m4a]/bestaudio": `best[height<=${quality}][ext=mp4]/best[height<=${quality}]`;

  try {
    if (type === "a") {
      const cached = getCachedFileId(cacheKey, cacheType);
      if (cached) {
        await grammyApi.sendAudio(chatId, cached, { caption: BOT_TAG, disable_notification: true } as any);
        return;
      }

      await withChatAction(bot, chatId, "upload_document", async () => {
        const stream = ytDlpStream(["-f", fmtStr, "--no-playlist", "-o", "-", url]);
        const msg = await grammyApi.sendAudio(chatId, new InputFile(stream, "audio.m4a"), {
          caption: BOT_TAG,
          disable_notification: true
        } as any);
        setCachedFileId(cacheKey, cacheType, 0, msg.audio.file_id);
      });
      return;
    }

    // Video — fetch format info first (gets exact formatId, size, title)
    await withChatAction(bot, chatId, "upload_video", async () => {
      const fmt = await getFormatInfo(url, fmtStr);

      // Notify if yt-dlp picked lower quality than requested
      if (fmt.height > 0 && fmt.height < quality) {
        await safeSendMessage(bot, chatId, `ℹ️ ${quality}p недоступно, скачиваю лучшее: ${fmt.height}p`);
      }

      const isLarge = fmt.sizeMB > GRAMMY_LIMIT_MB;

      if (!isLarge) {
        const cached = getCachedFileId(cacheKey, cacheType);
        if (cached) {
          await grammyApi.sendVideo(chatId, cached, {
            caption: `${fmt.title}\n\n${BOT_TAG}`,
            disable_notification: true,
            supports_streaming: true
          } as any);
          return;
        }
        const dlStream = ytDlpStream(["-f", fmt.formatId, "--no-playlist", "-o", "-", url]);
        const rnd = Math.floor(Math.random() * 100000) + 1;
        const msg = await grammyApi.sendVideo(chatId, new InputFile(dlStream, `video_${rnd}.mp4`), {
          caption: `${fmt.title}\n\n${BOT_TAG}`,
          disable_notification: true,
          supports_streaming: true
        } as any);
        setCachedFileId(cacheKey, cacheType, 0, msg.video.file_id);
        return;
      }

      // Large file — MTProto
      const client = await getBotMtproto();

      const cachedRef = getCachedFileId(cacheKey, cacheType);
      if (cachedRef) {
        try {
          const [idStr, hashStr, refHex] = cachedRef.split(":");
          const inputMedia = new Api.InputMediaDocument({
            id: new Api.InputDocument({
              id: BigInt(idStr) as any,
              accessHash: BigInt(hashStr) as any,
              fileReference: Buffer.from(refHex, "hex")
            })
          });
          await client.sendFile(chatId, {
            file: inputMedia,
            caption: `${fmt.title}\n\n${BOT_TAG}`,
            supportsStreaming: true,
            silent: true
          });
          return;
        }
        catch {
          // stale reference — fall through to re-download
        }
      }

      const sendAndCache = async (file: any) => {
        const msg = await client.sendFile(chatId, {
          file,
          caption: `${fmt.title}\n\n${BOT_TAG}`,
          supportsStreaming: true,
          silent: true
        }) as Api.Message;
        const doc = (msg?.media as Api.MessageMediaDocument)?.document as Api.Document | undefined;
        if (doc?.id && doc?.accessHash && doc?.fileReference) {
          const ref = `${doc.id}:${doc.accessHash}:${Buffer.from(doc.fileReference).toString("hex")}`;
          setCachedFileId(cacheKey, cacheType, 0, ref);
        }
      };

      if (fmt.sizeBytes > 0) {
        // Stream via named pipe — no disk write
        const pipePath = `${tmpdir()}/yt_pipe_${Date.now()}`;
        await mkfifo(pipePath);
        const dlProc = spawn(YT_DLP, ["-f", fmt.formatId, "--no-playlist", "-o", pipePath, url]);
        dlProc.stderr.on("data", () => {});
        try {
          await sendAndCache(new CustomFile(`${fmt.title}.mp4`, fmt.sizeBytes, pipePath));
        }
        finally {
          dlProc.kill();
          await unlink(pipePath).catch(() => {});
        }
      }
      else {
        // Fallback: write to disk (size unknown)
        const tmpPath = `${tmpdir()}/yt_${Date.now()}.mp4`;
        const dlStream = ytDlpStream(["-f", fmt.formatId, "--no-playlist", "-o", "-", url]);
        const writer = createWriteStream(tmpPath);
        await new Promise<void>((res, rej) => {
          dlStream.pipe(writer);
          writer.on("finish", res);
          writer.on("error", rej);
        });
        try {
          await sendAndCache(tmpPath);
        }
        finally {
          await unlink(tmpPath).catch(() => {});
        }
      }
    });
  }
  catch (error: any) {
    console.log("YouTube download error:", error);
    await safeSendMessage(bot, chatId, "Не удалось скачать. Попробуйте ещё раз.");
    await sendErrorToAdmin(bot, error, "youtube download", url, chatId, username);
  }
};
