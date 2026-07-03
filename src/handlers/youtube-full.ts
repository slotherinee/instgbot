import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import type TelegramBot from "node-telegram-bot-api";
import { InputFile } from "grammy";
import { BOT_TAG } from "../config";
import { grammyApi, withChatAction } from "../bot/safe-send";
import { safeSendMessage } from "../bot/safe-send";
import { sendErrorToAdmin } from "../bot/errors";
import { checkYouTubeRateLimit } from "../bot/rate-limit";
import { isAdmin } from "../config";
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

// Download to disk (handles both muxed and adaptive+ffmpeg merge)
const ytDlpToDisk = (args: string[], outPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const proc = spawn(YT_DLP, [...args, "-o", outPath]);
    proc.stderr.on("data", () => {});
    proc.on("close", code => code === 0 ? resolve() : reject(new Error(`yt-dlp exit ${code}`)));
  });

type FormatInfo = {
  formatId: string;
  sizeBytes: number;
  sizeMB: number;
  title: string;
  height: number;
  width: number;
  duration: number;
  thumbnailUrl: string;
};

// Returns selected format info after yt-dlp applies the format selector
const getFormatInfo = async (url: string, fmtStr: string): Promise<FormatInfo> => {
  const raw = await ytDlp(["--dump-json", "--no-playlist", "--no-cache-dir", "-f", fmtStr, url]);
  const info = JSON.parse(raw);
  const sizeBytes: number = info.filesize ?? 0;
  const sizeMB = sizeBytes? Math.round(sizeBytes / 1024 / 1024): info.filesize_approx? Math.round(info.filesize_approx / 1024 / 1024): 0;
  return {
    formatId: info.format_id,
    sizeBytes,
    sizeMB,
    title: info.title ?? "YouTube видео",
    height: info.height ?? 0,
    width: info.width ?? 0,
    duration: Math.round(info.duration ?? 0),
    thumbnailUrl: info.thumbnail ?? ""
  };
};

const fetchThumbnail = async (url: string): Promise<Buffer | null> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }
  catch {
    return null;
  }
};

// Adaptive formats (video+audio separate streams) require ffmpeg to merge.
// Muxed formats (combined) have exact sizeBytes from YouTube metadata.
// Format selector: try adaptive first (gives 480p/720p on any IP), fallback to muxed.
const videoFmtStr = (quality: number) =>
  `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}][ext=mp4]/best[height<=${quality}]`;

type PendingDownload = { url: string };

export const pendingYouTube = new Map<number, PendingDownload>();
const activeDownloads = new Set<number>();

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
  if (!isAdmin(userId) && activeDownloads.has(userId)) {
    await safeSendMessage(bot, chatId, "⏳ Дождитесь окончания текущей загрузки.");
    return;
  }

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
  const fmtStr = type === "a" ? "bestaudio[ext=m4a]/bestaudio" : videoFmtStr(quality);

  activeDownloads.add(userId);
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

    // Video — fetch format info (resolves adaptive vs muxed, gets exact formatId + size)
    await withChatAction(bot, chatId, "upload_video", async () => {
      const fmt = await getFormatInfo(url, fmtStr);

      if (fmt.height > 0 && fmt.height < quality) {
        await safeSendMessage(bot, chatId, `ℹ️ ${quality}p недоступно, скачиваю лучшее: ${fmt.height}p`);
      }

      // Muxed formats have exact sizeBytes; adaptive formats have sizeBytes=0
      // Only stream to grammy when format is muxed (sizeBytes>0) and small
      const isMuxedSmall = fmt.sizeBytes > 0 && fmt.sizeMB <= GRAMMY_LIMIT_MB;

      if (isMuxedSmall) {
        const thumb = fmt.thumbnailUrl ? await fetchThumbnail(fmt.thumbnailUrl) : null;
        const videoOpts: any = {
          caption: `${fmt.title}\n\n${BOT_TAG}`,
          disable_notification: true,
          supports_streaming: true,
          ...(fmt.width && { width: fmt.width }),
          ...(fmt.height && { height: fmt.height }),
          ...(fmt.duration && { duration: fmt.duration }),
          ...(thumb && { thumbnail: new InputFile(thumb, "thumb.jpg") })
        };

        const cached = getCachedFileId(cacheKey, cacheType);
        if (cached) {
          await grammyApi.sendVideo(chatId, cached, videoOpts);
          return;
        }
        const dlStream = ytDlpStream(["-f", fmt.formatId, "--no-playlist", "-o", "-", url]);
        const rnd = Math.floor(Math.random() * 100000) + 1;
        const msg = await grammyApi.sendVideo(chatId, new InputFile(dlStream, `video_${rnd}.mp4`), videoOpts);
        setCachedFileId(cacheKey, cacheType, 0, msg.video.file_id);
        return;
      }

      // Large or adaptive — download to disk (ffmpeg merges automatically), upload via MTProto
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

      const tmpPath = `${tmpdir()}/yt_${Date.now()}.mp4`;
      await ytDlpToDisk(["-f", fmt.formatId, "--no-playlist", "--merge-output-format", "mp4", url], tmpPath);
      const thumb = fmt.thumbnailUrl ? await fetchThumbnail(fmt.thumbnailUrl) : null;
      try {
        const videoAttrs = fmt.width && fmt.height && fmt.duration? [new Api.DocumentAttributeVideo({
          w: fmt.width,
          h: fmt.height,
          duration: fmt.duration,
          supportsStreaming: true,
          roundMessage: false
        })]: undefined;
        const msg = await client.sendFile(chatId, {
          file: tmpPath,
          caption: `${fmt.title}\n\n${BOT_TAG}`,
          supportsStreaming: true,
          silent: true,
          ...(thumb && { thumb }),
          ...(videoAttrs && { attributes: videoAttrs })
        }) as Api.Message;
        const doc = (msg?.media as Api.MessageMediaDocument)?.document as Api.Document | undefined;
        if (doc?.id && doc?.accessHash && doc?.fileReference) {
          const ref = `${doc.id}:${doc.accessHash}:${Buffer.from(doc.fileReference).toString("hex")}`;
          setCachedFileId(cacheKey, cacheType, 0, ref);
        }
      }
      finally {
        await unlink(tmpPath).catch(() => {});
      }
    });
  }
  catch (error: any) {
    console.log("YouTube download error:", error);
    await safeSendMessage(bot, chatId, "Не удалось скачать. Попробуйте ещё раз.");
    await sendErrorToAdmin(bot, error, "youtube download", url, chatId, username);
  }
  finally {
    activeDownloads.delete(userId);
  }
};
