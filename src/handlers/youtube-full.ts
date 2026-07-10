import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import type TelegramBot from "node-telegram-bot-api";
import { InputFile } from "grammy";
import { BOT_TAG, isAdmin } from "../config";
import { grammyApi, withChatAction } from "../bot/safe-send";
import { safeSendMessage } from "../bot/safe-send";
import { sendErrorToAdmin } from "../bot/errors";
import { checkYouTubeRateLimit } from "../bot/rate-limit";
import { getCachedFileId, setCachedFileId } from "../db/queries";

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

const mergeAdaptiveStream = async (
  url: string,
  videoFormatId: string,
  audioFormatId: string
): Promise<{ stream: Readable, cleanup: () => void }> => {
  const dir = await mkdtemp(`${tmpdir()}/ytpipe-`);
  const vfifo = `${dir}/v`;
  const afifo = `${dir}/a`;
  await mkfifo(vfifo);
  await mkfifo(afifo);

  const videoProc = spawn(YT_DLP, ["-f", videoFormatId, "--no-playlist", "-o", "-", url]);
  const audioProc = spawn(YT_DLP, ["-f", audioFormatId, "--no-playlist", "-o", "-", url]);
  videoProc.stderr.on("data", () => {});
  audioProc.stderr.on("data", () => {});
  (videoProc.stdout as Readable).pipe(createWriteStream(vfifo));
  (audioProc.stdout as Readable).pipe(createWriteStream(afifo));

  const ffmpeg = spawn("ffmpeg", [
    "-i", vfifo,
    "-i", afifo,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c", "copy",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1"
  ]);
  ffmpeg.stderr.on("data", () => {});

  const cleanup = () => {
    videoProc.kill();
    audioProc.kill();
    ffmpeg.kill();
    rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  ffmpeg.on("close", cleanup);
  videoProc.on("error", cleanup);
  audioProc.on("error", cleanup);

  return { stream: ffmpeg.stdout as unknown as Readable, cleanup };
};

type YtMeta = {
  title: string;
  duration: number;
  thumbnailUrl: string;
  formats: any[];
};

const YT_ARGS = ["--dump-json", "--no-playlist", "--no-cache-dir"];
const ytMetaCache = new Map<string, { meta: YtMeta, expiresAt: number }>();

const getYtMeta = async (url: string): Promise<YtMeta> => {
  const cached = ytMetaCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.meta;

  const raw = await ytDlp([...YT_ARGS, url]);
  const info = JSON.parse(raw);
  const meta: YtMeta = {
    title: info.title ?? "YouTube видео",
    duration: Math.round(info.duration ?? 0),
    thumbnailUrl: info.thumbnail ?? "",
    formats: info.formats ?? []
  };
  ytMetaCache.set(url, { meta, expiresAt: Date.now() + 5 * 60 * 1000 });
  return meta;
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

type ChosenVideo =
  | { kind: "adaptive", videoFormatId: string, audioFormatId: string, height: number, width: number }
  | { kind: "muxed", formatId: string, height: number, width: number };


const chooseVideoFormat = (formats: any[], quality: number): ChosenVideo | null => {
  const videoOnly = formats
    .filter((f: any) => f.vcodec !== "none" && f.acodec === "none" && f.ext === "mp4" && (f.height ?? 0) > 0 && f.height <= quality)
    .sort((a: any, b: any) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0));
  const audioOnly = formats
    .filter((f: any) => f.vcodec === "none" && f.acodec !== "none" && f.ext === "m4a")
    .sort((a: any, b: any) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0));

  if (videoOnly.length > 0 && audioOnly.length > 0) {
    const v = videoOnly[0];
    return {
      kind: "adaptive",
      videoFormatId: v.format_id,
      audioFormatId: audioOnly[0].format_id,
      height: v.height ?? 0,
      width: v.width ?? 0
    };
  }

  const muxed = formats
    .filter((f: any) => f.vcodec !== "none" && f.acodec !== "none" && (f.height ?? 0) > 0 && f.height <= quality)
    .sort((a: any, b: any) => (b.height ?? 0) - (a.height ?? 0) || ((b.ext === "mp4" ? 1 : 0) - (a.ext === "mp4" ? 1 : 0)));
  if (muxed.length > 0) {
    const m = muxed[0];
    return { kind: "muxed", formatId: m.format_id, height: m.height ?? 0, width: m.width ?? 0 };
  }

  return null;
};

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

  activeDownloads.add(userId);
  try {
    if (type === "a") {
      const cached = getCachedFileId(cacheKey, cacheType);
      if (cached) {
        await grammyApi.sendAudio(chatId, cached, { caption: BOT_TAG, disable_notification: true } as any);
        return;
      }

      await withChatAction(bot, chatId, "upload_document", async () => {
        const stream = ytDlpStream(["-f", "bestaudio[ext=m4a]/bestaudio", "--no-playlist", "-o", "-", url]);
        const msg = await grammyApi.sendAudio(chatId, new InputFile(stream, "audio.m4a"), {
          caption: BOT_TAG,
          disable_notification: true
        } as any);
        setCachedFileId(cacheKey, cacheType, 0, msg.audio.file_id);
      });
      return;
    }

    // Video
    await withChatAction(bot, chatId, "upload_video", async () => {
      const meta = await getYtMeta(url);
      const chosen = chooseVideoFormat(meta.formats, quality);
      if (!chosen) throw new Error("No video format found");

      if (chosen.height > 0 && chosen.height < quality) {
        await safeSendMessage(bot, chatId, `ℹ️ ${quality}p недоступно, скачиваю лучшее: ${chosen.height}p`);
      }

      const thumb = meta.thumbnailUrl ? await fetchThumbnail(meta.thumbnailUrl) : null;
      const videoOpts: any = {
        caption: `${meta.title}\n\n${BOT_TAG}`,
        disable_notification: true,
        supports_streaming: true,
        ...(chosen.width && { width: chosen.width }),
        ...(chosen.height && { height: chosen.height }),
        ...(meta.duration && { duration: meta.duration }),
        ...(thumb && { thumbnail: new InputFile(thumb, "thumb.jpg") })
      };

      const cached = getCachedFileId(cacheKey, cacheType);
      if (cached) {
        await grammyApi.sendVideo(chatId, cached, videoOpts);
        return;
      }

      const rnd = Math.floor(Math.random() * 100000) + 1;

      if (chosen.kind === "adaptive") {
        const { stream, cleanup } = await mergeAdaptiveStream(url, chosen.videoFormatId, chosen.audioFormatId);
        try {
          const msg = await grammyApi.sendVideo(chatId, new InputFile(stream, `video_${rnd}.mp4`), videoOpts);
          setCachedFileId(cacheKey, cacheType, 0, msg.video.file_id);
        }
        finally {
          cleanup();
        }
      }
      else {
        const stream = ytDlpStream(["-f", chosen.formatId, "--no-playlist", "-o", "-", url]);
        const msg = await grammyApi.sendVideo(chatId, new InputFile(stream, `video_${rnd}.mp4`), videoOpts);
        setCachedFileId(cacheKey, cacheType, 0, msg.video.file_id);
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
