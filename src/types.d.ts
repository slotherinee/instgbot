declare module "btch-downloader" {
  export interface YoutubeResult {
    title: string;
    thumbnail: string;
    mp4?: string;
    quality: string;
  }

  export function youtube (url: string): Promise<YoutubeResult>;
}
